//! Preparing rows for a table, shared by the engine and the WASM writer: aligning batches to the
//! table schema, stamping the insertion time, sorting by `(partition, series…, time, insertion
//! time)`, splitting by partition, and keeping the latest write of each `(series…, time)` — every
//! file is then sorted and free of duplicates on its own, which dedup on read and streaming
//! compaction rely on.

use std::sync::Arc;

use arrow_array::{Array, ArrayRef, Int32Array, RecordBatch, TimestampMicrosecondArray, UInt32Array, new_null_array};
use arrow_cast::cast;
use arrow_ord::partition::partition;
use arrow_ord::sort::{SortColumn, lexsort_to_indices};
use arrow_schema::{DataType, Field, Schema, SchemaRef, SortOptions, TimeUnit};
use arrow_select::concat::concat_batches;
use arrow_select::take::take_record_batch;
use arrow_select::zip::zip;

use crate::Contract;
use crate::error::{WriteError, WriteResult};

/// Ascending with nulls first: the order Timelake writes and declares for `(series…, time)`.
pub const ASCENDING: SortOptions = SortOptions { descending: false, nulls_first: true };

/// The time zone timestamps with any zone are stored in.
pub const UTC: &str = "+00:00";

/// Rows of one time partition (`None` for unpartitioned tables), sorted by the table's write order.
pub type PartitionRows = (Option<i32>, RecordBatch);

/// Casts and reorders a batch to the table schema by column name. Missing nullable columns are
/// filled with nulls; extra columns are an error.
pub fn align_batch(batch: &RecordBatch, schema: &SchemaRef) -> WriteResult<RecordBatch> {
    let input = batch.schema();
    if let Some(extra) = input.fields().iter().find(|f| schema.field_with_name(f.name()).is_err()) {
        return Err(WriteError::invalid(format!("column {:?} is not in the table schema", extra.name())));
    }
    let columns = schema
        .fields()
        .iter()
        .map(|f| match input.index_of(f.name()) {
            Ok(i) if batch.column(i).data_type() == f.data_type() => Ok(batch.column(i).clone()),
            Ok(i) => Ok(cast(batch.column(i), f.data_type())?),
            Err(_) if f.is_nullable() => Ok(new_null_array(f.data_type(), batch.num_rows())),
            Err(_) => Err(WriteError::invalid(format!("required column {:?} is missing", f.name()))),
        })
        .collect::<WriteResult<Vec<ArrayRef>>>()?;
    RecordBatch::try_new(schema.clone(), columns)
        .map_err(|e| WriteError::invalid(format!("batch does not fit the table schema: {e}")))
}

/// `batch` with its insertion-time `column` set to `now` (µs since the epoch) where it is missing or
/// null; values a caller supplied (an import keeping arrival times) stay.
pub fn with_ingest_time(batch: &RecordBatch, column: &str, now: i64) -> WriteResult<RecordBatch> {
    let n = batch.num_rows();
    let fill = || Arc::new(TimestampMicrosecondArray::from_value(now, n).with_timezone(UTC)) as ArrayRef;
    let ty = DataType::Timestamp(TimeUnit::Microsecond, Some(UTC.into()));
    let schema = batch.schema();
    let Ok(i) = schema.index_of(column) else {
        let mut fields: Vec<_> = schema.fields().iter().cloned().collect();
        fields.push(Arc::new(Field::new(column, ty, false)));
        let mut columns = batch.columns().to_vec();
        columns.push(fill());
        return Ok(RecordBatch::try_new(Arc::new(Schema::new(fields)), columns)?);
    };
    if batch.column(i).null_count() == 0 {
        return Ok(batch.clone());
    }
    let given = cast(batch.column(i), &ty)?;
    let filled = zip(&arrow_arith::boolean::is_not_null(&given)?, &given, &fill())?;
    let mut fields: Vec<_> = schema.fields().iter().cloned().collect();
    fields[i] = Arc::new(Field::new(column, filled.data_type().clone(), false));
    let mut columns = batch.columns().to_vec();
    columns[i] = filled;
    Ok(RecordBatch::try_new(Arc::new(Schema::new(fields)), columns)?)
}

/// Aligns `batches` to `schema`, stamps the insertion time `now`, sorts by `(partition, series…,
/// time, insertion time)` with input order as the tiebreak, splits by partition and, when dedup
/// is on, keeps the last of rows with the same `(series…, time)`.
pub fn sort_and_split(
    schema: &SchemaRef,
    contract: &Contract,
    batches: &[RecordBatch],
    now: i64,
) -> WriteResult<Vec<PartitionRows>> {
    let split = sort_and_split_all(schema, contract, batches, now)?;
    let keys = contract.sort_columns();
    if !contract.dedup || keys.is_empty() {
        return Ok(split);
    }
    split.into_iter().map(|(p, rows)| Ok((p, last_per_group(&rows, &keys)?))).collect()
}

fn sort_and_split_all(
    schema: &SchemaRef,
    contract: &Contract,
    batches: &[RecordBatch],
    now: i64,
) -> WriteResult<Vec<PartitionRows>> {
    let ingest = contract.ingest_time_column.as_deref();
    let aligned = batches
        .iter()
        .filter(|b| b.num_rows() > 0)
        .map(|b| align_batch(&ingest.map_or_else(|| Ok(b.clone()), |c| with_ingest_time(b, c, now))?, schema))
        .collect::<WriteResult<Vec<_>>>()?;
    if aligned.is_empty() {
        return Ok(vec![]);
    }
    let all = concat_batches(schema, &aligned)?;
    let partitions = partition_values(&all, contract)?;
    let mut keys: Vec<ArrayRef> =
        partitions.iter().map(|p| Arc::new(Int32Array::from(p.clone())) as ArrayRef).collect();
    keys.extend(columns(&all, &contract.write_order())?);
    if keys.is_empty() {
        return Ok(vec![(None, all)]);
    }
    let order = stable_sort_indices(&keys, all.num_rows())?;
    let sorted = take_record_batch(&all, &order)?;
    let Some(partitions) = partitions else { return Ok(vec![(None, sorted)]) };

    // Rows are now grouped by partition: slice out each run.
    let sorted_partitions: Vec<i32> = order.values().iter().map(|&i| partitions[i as usize]).collect();
    let mut out = vec![];
    let mut offset = 0;
    for run in sorted_partitions.chunk_by(|a, b| a == b) {
        out.push((Some(run[0]), sorted.slice(offset, run.len())));
        offset += run.len();
    }
    Ok(out)
}

/// Partition value of every row (`None` for unpartitioned tables).
fn partition_values(batch: &RecordBatch, contract: &Contract) -> WriteResult<Option<Vec<i32>>> {
    let (Some(time_column), Some(chunk)) = (&contract.time_column, contract.chunk) else { return Ok(None) };
    let times =
        cast(batch.column(batch.schema().index_of(time_column)?), &DataType::Timestamp(TimeUnit::Microsecond, None))?;
    let Some(times) = times.as_any().downcast_ref::<TimestampMicrosecondArray>() else {
        return Err(WriteError::invalid(format!("time column {time_column:?} is not a timestamp")));
    };
    if times.null_count() > 0 {
        return Err(WriteError::invalid(format!("time column {time_column:?} contains nulls")));
    }
    let values = times.values().iter().map(|&t| chunk.value(t)).collect::<crate::Result<_>>()?;
    Ok(Some(values))
}

/// The columns of `batch` named `names`, in that order.
pub fn columns(batch: &RecordBatch, names: &[String]) -> WriteResult<Vec<ArrayRef>> {
    let schema = batch.schema();
    names.iter().map(|n| Ok(batch.column(schema.index_of(n)?).clone())).collect()
}

/// Row indices that sort by `keys` (ascending, nulls first), keeping input order among equal keys.
pub fn stable_sort_indices(keys: &[ArrayRef], rows: usize) -> WriteResult<UInt32Array> {
    let rows = u32::try_from(rows).map_err(|_| too_many_rows(rows))?;
    let mut columns: Vec<SortColumn> =
        keys.iter().map(|k| SortColumn { values: k.clone(), options: Some(ASCENDING) }).collect();
    columns.push(SortColumn { values: Arc::new(UInt32Array::from_iter_values(0..rows)), options: None });
    Ok(lexsort_to_indices(&columns, None)?)
}

/// `batch` sorted by its columns `names`, keeping input order among equal keys.
pub fn stable_sort(batch: &RecordBatch, names: &[String]) -> WriteResult<RecordBatch> {
    if names.is_empty() || batch.num_rows() == 0 {
        return Ok(batch.clone());
    }
    let indices = stable_sort_indices(&columns(batch, names)?, batch.num_rows())?;
    Ok(take_record_batch(batch, &indices)?)
}

/// The last row of each run of equal values in the columns `names` of a sorted batch (the last
/// row overall if `names` is empty).
pub fn last_per_group(sorted: &RecordBatch, names: &[String]) -> WriteResult<RecordBatch> {
    let rows = sorted.num_rows();
    if rows == 0 {
        return Ok(sorted.clone());
    }
    if names.is_empty() {
        return Ok(sorted.slice(rows - 1, 1));
    }
    let groups = partition(&columns(sorted, names)?)?.ranges();
    if groups.len() == rows {
        return Ok(sorted.clone());
    }
    let last: UInt32Array =
        groups.iter().map(|g| u32::try_from(g.end - 1)).collect::<Result<_, _>>().map_err(|_| too_many_rows(rows))?;
    Ok(take_record_batch(sorted, &last)?)
}

/// Newest row per series among `batches`, or `None` without a time column or rows. On equal
/// times the later insertion wins, then the later row (later input position), matching dedup's
/// "latest write wins".
pub fn latest_per_series(
    schema: &SchemaRef,
    contract: &Contract,
    batches: &[RecordBatch],
) -> WriteResult<Option<RecordBatch>> {
    if contract.time_column.is_none() || batches.iter().all(|b| b.num_rows() == 0) {
        return Ok(None);
    }
    let sorted = stable_sort(&concat_batches(schema, batches)?, &contract.write_order())?;
    Ok(Some(last_per_group(&sorted, &contract.series_key)?))
}

fn too_many_rows(rows: usize) -> WriteError {
    WriteError::invalid(format!("{rows} rows are too many to sort at once"))
}

#[cfg(test)]
mod tests {
    use arrow_array::{Int32Array, StringArray};
    use arrow_schema::{DataType, Field, Schema};

    use super::*;

    fn batch(keys: &[Option<i32>], tags: &[&str]) -> RecordBatch {
        let schema =
            Schema::new(vec![Field::new("k", DataType::Int32, true), Field::new("tag", DataType::Utf8, false)]);
        RecordBatch::try_new(
            Arc::new(schema),
            vec![Arc::new(Int32Array::from(keys.to_vec())), Arc::new(StringArray::from(tags.to_vec()))],
        )
        .unwrap()
    }

    fn tags(b: &RecordBatch) -> Vec<&str> {
        let tags = b.column(1).as_any().downcast_ref::<StringArray>().unwrap();
        (0..tags.len()).map(|i| tags.value(i)).collect()
    }

    #[test]
    fn sorts_nulls_first_and_keeps_input_order_on_ties() {
        let b = batch(&[Some(2), None, Some(1), Some(2), Some(1)], &["a", "b", "c", "d", "e"]);
        let sorted = stable_sort(&b, &["k".into()]).unwrap();
        assert_eq!(tags(&sorted), ["b", "c", "e", "a", "d"]);
        assert_eq!(tags(&last_per_group(&sorted, &["k".into()]).unwrap()), ["b", "e", "d"]);
    }

    #[test]
    fn without_keys_keeps_the_last_row() {
        let b = batch(&[Some(1), Some(2)], &["a", "b"]);
        assert_eq!(tags(&stable_sort(&b, &[]).unwrap()), ["a", "b"]);
        assert_eq!(tags(&last_per_group(&b, &[]).unwrap()), ["b"]);
    }

    #[test]
    fn empty_input() {
        let b = batch(&[], &[]);
        assert_eq!(last_per_group(&stable_sort(&b, &["k".into()]).unwrap(), &["k".into()]).unwrap().num_rows(), 0);
    }
}
