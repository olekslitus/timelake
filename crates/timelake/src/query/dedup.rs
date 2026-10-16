//! Dedup on read (SPEC §9.1): files that may hold the same `(series…, time)` are merged in key order
//! and only the newest write of each key is kept, so queries never see duplicates that compaction
//! hasn't removed yet.
//!
//! Every file is sorted by the key and free of duplicates on its own (a write keeps the last of
//! equal keys), so only files of one partition whose key bounds overlap can share a key. Such files
//! are read with their commit rank as a constant column, split by a hash of the key (every copy of
//! a key lands in the same slice), each slice merged by `(series…, time, rank)`, and [`DedupExec`]
//! keeps the last row of each key in each slice.

use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::sync::Arc;

use arrow::array::{RecordBatch, UInt32Array};
use arrow::compute::{concat_batches, take_record_batch};
use arrow::datatypes::SchemaRef;
use arrow::row::{OwnedRow, RowConverter, SortField};
use datafusion::common::Statistics;
use datafusion::config::ConfigOptions;
use datafusion::error::{DataFusionError, Result as DfResult};
use datafusion::execution::TaskContext;
use datafusion::physical_expr::expressions::Column;
use datafusion::physical_expr::{EquivalenceProperties, LexOrdering, OrderingRequirements, PhysicalExpr};
use datafusion::physical_plan::execution_plan::{Boundedness, EmissionType};
use datafusion::physical_plan::filter_pushdown::{ChildFilterDescription, FilterDescription, FilterPushdownPhase};
use datafusion::physical_plan::stream::RecordBatchStreamAdapter;
use datafusion::physical_plan::{
    DisplayAs, DisplayFormatType, Distribution, ExecutionPlan, ExecutionPlanProperties, PlanProperties,
    SendableRecordBatchStream,
};
use futures::StreamExt;
use iceberg::spec::{Datum, PrimitiveLiteral};

use super::stats::field_id;
use crate::sort::ASCENDING;
use crate::table::LiveEntry;
use crate::write::file_partition;

/// The column that carries each file's commit rank in a deduplicated scan (dropped before output).
pub(super) const RANK: &str = "__timelake_rank";

/// Groups of two or more `files` (indices) that may hold rows with the same key: files of one
/// partition whose bounds overlap on every key column. A file in no group shares no key.
///
/// `keys` are the sort columns, `(series…, time)`, as indices into `schema`.
pub(super) fn overlapping_groups(schema: &SchemaRef, keys: &[usize], files: &[LiveEntry]) -> Vec<Vec<usize>> {
    let Some((&time, _)) = keys.split_last() else { return vec![] };
    let ids: Vec<Option<i32>> = keys.iter().map(|&k| field_id(schema, k)).collect();
    let time_id = field_id(schema, time);
    let mut by_partition: BTreeMap<Option<i32>, Vec<usize>> = BTreeMap::new();
    for (i, f) in files.iter().enumerate() {
        by_partition.entry(file_partition(&f.data_file)).or_default().push(i);
    }
    let mut parent: Vec<usize> = (0..files.len()).collect();
    for mut members in by_partition.into_values() {
        // Sweep in order of the earliest time: a file can only overlap the files still open.
        let span = |i: usize| time_span(&files[i], time_id);
        members.sort_by_key(|&i| span(i));
        let mut open: Vec<usize> = vec![];
        for &i in &members {
            let (start, _) = span(i);
            open.retain(|&j| span(j).1 >= start);
            for &j in &open {
                if ids.iter().all(|&id| bounds_overlap(&files[i], &files[j], id)) {
                    union(&mut parent, i, j);
                }
            }
            open.push(i);
        }
    }
    let mut groups: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for i in 0..files.len() {
        groups.entry(find(&mut parent, i)).or_default().push(i);
    }
    groups.into_values().filter(|g| g.len() > 1).collect()
}

/// The file's time bounds in the column's unit (unbounded where the manifest has none).
fn time_span(f: &LiveEntry, id: Option<i32>) -> (i64, i64) {
    let bound = |b: Option<&Datum>| match b.map(Datum::literal) {
        Some(PrimitiveLiteral::Long(v)) => Some(*v),
        _ => None,
    };
    let Some(id) = id else { return (i64::MIN, i64::MAX) };
    let df = &f.data_file;
    (bound(df.lower_bounds().get(&id)).unwrap_or(i64::MIN), bound(df.upper_bounds().get(&id)).unwrap_or(i64::MAX))
}

/// Whether two files' bounds on a column overlap (or can't be compared).
fn bounds_overlap(a: &LiveEntry, b: &LiveEntry, id: Option<i32>) -> bool {
    let Some(id) = id else { return true };
    let before =
        |x: &LiveEntry, y: &LiveEntry| match (x.data_file.upper_bounds().get(&id), y.data_file.lower_bounds().get(&id))
        {
            (Some(hi), Some(lo)) => hi < lo,
            _ => false,
        };
    !before(a, b) && !before(b, a)
}

fn find(parent: &mut [usize], mut i: usize) -> usize {
    while parent[i] != i {
        parent[i] = parent[parent[i]];
        i = parent[i];
    }
    i
}

fn union(parent: &mut [usize], a: usize, b: usize) {
    let (ra, rb) = (find(parent, a), find(parent, b));
    parent[ra.max(rb)] = ra.min(rb);
}

/// Keeps the last row of each run of equal keys, in each input partition: the input is
/// hash-partitioned by the key (so all copies of a key are in one partition) and sorted by the key
/// and, among equal keys, oldest write first.
#[derive(Debug)]
pub(super) struct DedupExec {
    input: Arc<dyn ExecutionPlan>,
    /// Key column indices in the input schema.
    keys: Vec<usize>,
    ordering: LexOrdering,
    properties: Arc<PlanProperties>,
}

impl DedupExec {
    /// `ordering` is the input's sort order, the key columns `keys` first.
    pub(super) fn new(input: Arc<dyn ExecutionPlan>, keys: Vec<usize>, ordering: LexOrdering) -> Self {
        let eq = EquivalenceProperties::new_with_orderings(input.schema(), [ordering.clone()]);
        let properties = Arc::new(PlanProperties::new(
            eq,
            input.output_partitioning().clone(),
            EmissionType::Incremental,
            Boundedness::Bounded,
        ));
        Self { input, keys, ordering, properties }
    }
}

impl DisplayAs for DedupExec {
    fn fmt_as(&self, _t: DisplayFormatType, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let schema = self.input.schema();
        let keys: Vec<&str> = self.keys.iter().map(|&k| schema.field(k).name().as_str()).collect();
        write!(f, "DedupExec: keep last of [{}]", keys.join(", "))
    }
}

impl ExecutionPlan for DedupExec {
    fn name(&self) -> &'static str {
        "DedupExec"
    }

    fn properties(&self) -> &Arc<PlanProperties> {
        &self.properties
    }

    fn children(&self) -> Vec<&Arc<dyn ExecutionPlan>> {
        vec![&self.input]
    }

    fn required_input_distribution(&self) -> Vec<Distribution> {
        let schema = self.input.schema();
        let keys = self.keys.iter().map(|&k| Arc::new(Column::new(schema.field(k).name(), k)) as Arc<dyn PhysicalExpr>);
        vec![Distribution::HashPartitioned(keys.collect())]
    }

    fn required_input_ordering(&self) -> Vec<Option<OrderingRequirements>> {
        vec![Some(OrderingRequirements::from(self.ordering.clone()))]
    }

    fn maintains_input_order(&self) -> Vec<bool> {
        vec![true]
    }

    fn benefits_from_input_partitioning(&self) -> Vec<bool> {
        vec![false]
    }

    fn with_new_children(
        self: Arc<Self>,
        mut children: Vec<Arc<dyn ExecutionPlan>>,
    ) -> DfResult<Arc<dyn ExecutionPlan>> {
        Ok(Arc::new(Self::new(children.swap_remove(0), self.keys.clone(), self.ordering.clone())))
    }

    fn execute(&self, partition: usize, context: Arc<TaskContext>) -> DfResult<SendableRecordBatchStream> {
        let schema = self.input.schema();
        let fields =
            self.keys.iter().map(|&k| SortField::new_with_options(schema.field(k).data_type().clone(), ASCENDING));
        let mut state =
            LastOfKey { keys: self.keys.clone(), rows: RowConverter::new(fields.collect())?, pending: None };
        let input = self.input.execute(partition, context)?.map(Some).chain(futures::stream::once(async { None }));
        let output = input.filter_map(move |item| {
            let out = match item {
                Some(Ok(batch)) => state.push(&batch).transpose(),
                Some(Err(e)) => Some(Err(e)),
                None => state.pending.take().map(|(_, row)| Ok(row)),
            };
            futures::future::ready(out)
        });
        Ok(Box::pin(RecordBatchStreamAdapter::new(schema, output)))
    }

    fn gather_filters_for_pushdown(
        &self,
        _phase: FilterPushdownPhase,
        parent_filters: Vec<Arc<dyn PhysicalExpr>>,
        _config: &ConfigOptions,
    ) -> DfResult<FilterDescription> {
        // A filter on the key alone keeps or drops every copy of a row together, so it can run
        // before dedup (and prune row groups); any other filter must see only the newest copy.
        let keys: HashSet<usize> = self.keys.iter().copied().collect();
        let child = ChildFilterDescription::from_child_with_allowed_indices(&parent_filters, keys, &self.input)?;
        Ok(FilterDescription::new().with_child(child))
    }

    fn partition_statistics(&self, partition: Option<usize>) -> DfResult<Arc<Statistics>> {
        // Fewer rows than the input: the counts are an upper bound.
        Ok(Arc::new(Arc::unwrap_or_clone(self.input.partition_statistics(partition)?).to_inexact()))
    }
}

/// The streaming state of [`DedupExec`]: the last row seen, held back until the next row shows
/// whether a newer write of its key follows.
struct LastOfKey {
    keys: Vec<usize>,
    rows: RowConverter,
    pending: Option<(OwnedRow, RecordBatch)>,
}

impl LastOfKey {
    /// The rows of `batch` (and the held-back row before it) that are the last of their key.
    fn push(&mut self, batch: &RecordBatch) -> DfResult<Option<RecordBatch>> {
        let n = batch.num_rows();
        if n == 0 {
            return Ok(None);
        }
        let keys: Vec<_> = self.keys.iter().map(|&k| batch.column(k).clone()).collect();
        let rows = self.rows.convert_columns(&keys)?;
        let mut out = vec![];
        if let Some((key, row)) = self.pending.take()
            && key.row() != rows.row(0)
        {
            out.push(row);
        }
        let last = (0..n - 1)
            .filter(|&i| rows.row(i) != rows.row(i + 1))
            .map(u32::try_from)
            .collect::<Result<UInt32Array, _>>()
            .map_err(|e| DataFusionError::External(Box::new(e)))?;
        if !last.is_empty() {
            out.push(take_record_batch(batch, &last)?);
        }
        self.pending = Some((rows.row(n - 1).owned(), batch.slice(n - 1, 1)));
        if out.is_empty() {
            return Ok(None);
        }
        Ok(Some(concat_batches(&batch.schema(), &out)?))
    }
}

#[cfg(test)]
mod tests {
    use arrow::array::{Array, Int32Array, StringArray};
    use arrow::datatypes::{DataType, Field, Schema};

    use super::*;

    fn batch(keys: &[i32], tags: &[&str]) -> RecordBatch {
        let schema =
            Schema::new(vec![Field::new("k", DataType::Int32, false), Field::new("tag", DataType::Utf8, false)]);
        RecordBatch::try_new(
            Arc::new(schema),
            vec![Arc::new(Int32Array::from(keys.to_vec())), Arc::new(StringArray::from(tags.to_vec()))],
        )
        .unwrap()
    }

    fn tags(batches: &[RecordBatch]) -> Vec<String> {
        batches
            .iter()
            .flat_map(|b| {
                let t = b.column(1).as_any().downcast_ref::<StringArray>().unwrap().clone();
                (0..t.len()).map(move |i| t.value(i).to_string())
            })
            .collect()
    }

    /// A file another engine wrote, unsorted and repeating a key, is deduplicated on its own; a
    /// Timelake file next to it is read as it is.
    #[tokio::test]
    async fn an_unsorted_file_is_deduplicated_on_its_own() {
        use crate::testing::{T0, append_unsorted, batch as rows, faulty_lake, opts, schema};

        let (lake, _store) = faulty_lake();
        let t = lake.create_table("iot.r", &schema(), opts()).await.unwrap();
        let day = crate::write::sort_and_split(&t, &[rows(&[(T0, 1, 0.0)])]).unwrap()[0].0;
        let t = append_unsorted(&t, day, rows(&[(T0 + 5, 2, 1.0), (T0, 1, 2.0), (T0 + 5, 2, 3.0)])).await;
        let later = T0 + 2 * 86_400_000_000;
        t.append(&[rows(&[(later, 1, 4.0)])], crate::append::AppendOptions::default()).await.unwrap();
        let session = crate::Session::new(lake.clone());
        let sql = "SELECT device, value FROM iot.r ORDER BY time, device";
        let out = session.sql(sql).await.unwrap().collect().await.unwrap();
        let values: Vec<f64> = out
            .iter()
            .flat_map(|b| b.column(1).as_any().downcast_ref::<arrow::array::Float64Array>().unwrap().values().to_vec())
            .collect();
        assert_eq!(values, [2.0, 3.0, 4.0]);
    }

    /// Runs of equal keys that span batches keep their last row, wherever it is.
    #[test]
    fn keeps_the_last_row_of_each_key_across_batches() {
        let fields = vec![SortField::new_with_options(DataType::Int32, ASCENDING)];
        let mut state = LastOfKey { keys: vec![0], rows: RowConverter::new(fields).unwrap(), pending: None };
        let mut out = vec![];
        for b in
            [batch(&[1, 1, 2], &["a", "b", "c"]), batch(&[2, 3], &["d", "e"]), batch(&[3], &["f"]), batch(&[], &[])]
        {
            out.extend(state.push(&b).unwrap());
        }
        out.extend(state.pending.take().map(|(_, row)| row));
        assert_eq!(tags(&out), ["b", "d", "f"]);
    }
}
