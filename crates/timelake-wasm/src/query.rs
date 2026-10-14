//! Time-series queries over Timelake files, sans I/O: plan which files and byte ranges to fetch,
//! then decode, filter and aggregate what the host fetched.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use arrow_array::cast::AsArray;
use arrow_array::types::{Float64Type, Int64Type};
use arrow_array::{Array, ArrayRef, BooleanArray, Int32Array, Int64Array, RecordBatch, StringArray};
use arrow_schema::{DataType, SchemaRef};
use bytes::{Buf, Bytes};
use parquet::arrow::ProjectionMask;
use parquet::arrow::arrow_reader::{ArrowReaderMetadata, ArrowReaderOptions, ParquetRecordBatchReaderBuilder};
use parquet::file::metadata::{ParquetMetaData, ParquetMetaDataReader};
use parquet::file::reader::{ChunkReader, Length};
use parquet::file::statistics::Statistics;
use serde::Deserialize;
use serde_json::Value as Json;
use timelake_format::bounds::Bound;

use crate::Error;
use crate::meta::DataFile;

/// What to read. Times are microseconds since the epoch; `[from, to)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySpec {
    pub time_column: Option<String>,
    /// Column → allowed values (series key filters).
    #[serde(default)]
    pub series: HashMap<String, Vec<Json>>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    /// Columns to return for row queries (empty = all).
    #[serde(default)]
    pub columns: Vec<String>,
    pub limit: Option<usize>,
    /// Order rows by time descending (default ascending).
    #[serde(default)]
    pub descending: bool,
    pub bucket: Option<BucketSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketSpec {
    /// Bucket width in microseconds.
    pub every: i64,
    #[serde(default)]
    pub origin: i64,
    /// Extra group-by columns (typically the series key).
    #[serde(default)]
    pub by: Vec<String>,
    pub aggs: Vec<AggSpec>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AggSpec {
    /// Column name, or "*" for count(*).
    pub column: String,
    /// count | sum | avg | min | max | first | last
    pub op: String,
}

impl QuerySpec {
    /// Columns that must be decoded: output, filters, buckets and aggregates.
    fn needed_columns(&self, schema: &arrow_schema::Schema) -> Vec<String> {
        let mut cols: Vec<String> = vec![];
        let mut add = |c: &str| {
            if c != "*" && schema.field_with_name(c).is_ok() && !cols.iter().any(|x| x == c) {
                cols.push(c.to_string());
            }
        };
        match &self.bucket {
            Some(b) => {
                b.by.iter().for_each(|c| add(c));
                b.aggs.iter().for_each(|a| add(&a.column));
            }
            None if self.columns.is_empty() => schema.fields().iter().for_each(|f| add(f.name())),
            None => self.columns.iter().for_each(|c| add(c)),
        }
        if let Some(tc) = &self.time_column {
            add(tc);
        }
        self.series.keys().for_each(|c| add(c));
        cols
    }
}

// --- pruning ------------------------------------------------------------------------------------

fn bound_cmp(b: &Bound, v: &Json) -> Option<std::cmp::Ordering> {
    match (b, v) {
        (Bound::Int(x), Json::Number(n)) => {
            n.as_i64().map(|n| x.cmp(&n)).or_else(|| (*x as f64).partial_cmp(&n.as_f64()?))
        }
        (Bound::Float(x), Json::Number(n)) => x.partial_cmp(&n.as_f64()?),
        (Bound::Str(x), Json::String(s)) => Some(x.as_str().cmp(s)),
        _ => None,
    }
}

fn may_contain(lower: Option<&Bound>, upper: Option<&Bound>, v: &Json) -> bool {
    use std::cmp::Ordering::*;
    let lo_ok = lower.and_then(|l| bound_cmp(l, v)).is_none_or(|o| o != Greater);
    let hi_ok = upper.and_then(|u| bound_cmp(u, v)).is_none_or(|o| o != Less);
    lo_ok && hi_ok
}

fn time_overlaps(lower: Option<i64>, upper: Option<i64>, spec: &QuerySpec) -> bool {
    if let (Some(from), Some(hi)) = (spec.from, upper)
        && hi < from
    {
        return false;
    }
    if let (Some(to), Some(lo)) = (spec.to, lower)
        && lo >= to
    {
        return false;
    }
    true
}

/// Files that may hold matching rows, judged by their Iceberg column bounds.
pub fn plan_files<'a>(files: &'a [DataFile], spec: &QuerySpec) -> Vec<&'a DataFile> {
    let as_int = |b: Option<&Bound>| match b {
        Some(Bound::Int(x)) => Some(*x),
        _ => None,
    };
    files
        .iter()
        .filter(|f| {
            let time_ok = match &spec.time_column {
                Some(tc) => time_overlaps(as_int(f.lower.get(tc)), as_int(f.upper.get(tc)), spec),
                None => true,
            };
            time_ok
                && spec.series.iter().all(|(col, values)| {
                    values.is_empty() || values.iter().any(|v| may_contain(f.lower.get(col), f.upper.get(col), v))
                })
        })
        .collect()
}

// --- Parquet over fetched byte ranges ------------------------------------------------------------

/// The bytes of a Parquet file the host has fetched so far, as a sparse file.
#[derive(Clone, Default)]
struct SparseFile {
    len: u64,
    chunks: BTreeMap<u64, Bytes>,
}

impl SparseFile {
    fn find(&self, start: u64, length: u64) -> parquet::errors::Result<Bytes> {
        if let Some((&off, chunk)) = self.chunks.range(..=start).next_back() {
            let end = off + chunk.len() as u64;
            if start + length <= end {
                return Ok(chunk.slice((start - off) as usize..(start - off + length) as usize));
            }
        }
        Err(parquet::errors::ParquetError::General(format!("bytes {start}..{} were not fetched", start + length)))
    }
}

impl Length for SparseFile {
    fn len(&self) -> u64 {
        self.len
    }
}

impl ChunkReader for SparseFile {
    type T = bytes::buf::Reader<Bytes>;

    fn get_read(&self, start: u64) -> parquet::errors::Result<Self::T> {
        let (&off, chunk) = self
            .chunks
            .range(..=start)
            .next_back()
            .ok_or_else(|| parquet::errors::ParquetError::General(format!("byte {start} was not fetched")))?;
        Ok(chunk.slice((start - off) as usize..).reader())
    }

    fn get_bytes(&self, start: u64, length: usize) -> parquet::errors::Result<Bytes> {
        self.find(start, length as u64)
    }
}

/// How many trailing bytes hold the footer (metadata + 8), given at least the last 8 bytes.
pub fn footer_len(tail: &[u8]) -> Result<u64, Error> {
    let n = tail.len();
    if n < 8 || &tail[n - 4..] != b"PAR1" {
        return Err(Error("not a Parquet file".into()));
    }
    let meta_len = u32::from_le_bytes([tail[n - 8], tail[n - 7], tail[n - 6], tail[n - 5]]) as u64;
    Ok(meta_len + 8)
}

pub struct OpenFile {
    data: SparseFile,
    meta: Arc<ParquetMetaData>,
    reader_meta: ArrowReaderMetadata,
    selected: Vec<usize>,
    projection: Vec<usize>,
}

impl OpenFile {
    pub fn new(size: u64, tail: Vec<u8>) -> Result<Self, Error> {
        let need = footer_len(&tail)?;
        if (tail.len() as u64) < need {
            return Err(Error(format!("need the last {need} bytes for the footer")));
        }
        let meta_bytes = &tail[tail.len() - need as usize..tail.len() - 8];
        let meta = Arc::new(
            ParquetMetaDataReader::decode_metadata(meta_bytes)
                .map_err(|e| Error(format!("bad Parquet footer: {e}")))?,
        );
        let reader_meta =
            ArrowReaderMetadata::try_new(meta.clone(), ArrowReaderOptions::new()).map_err(|e| Error(e.to_string()))?;
        Ok(Self {
            data: SparseFile { len: size, chunks: BTreeMap::new() },
            meta,
            reader_meta,
            selected: vec![],
            projection: vec![],
        })
    }

    pub fn arrow_schema(&self) -> SchemaRef {
        self.reader_meta.schema().clone()
    }

    /// Selects row groups by their statistics and returns the byte ranges to fetch: the column
    /// chunks of the needed columns, coalesced when close together.
    pub fn plan(&mut self, spec: &QuerySpec) -> Vec<(u64, u64)> {
        let schema = self.arrow_schema();
        let needed = spec.needed_columns(&schema);
        let descr = self.meta.file_metadata().schema_descr();
        // Leaf column index for each needed top-level column (Timelake tables are flat).
        self.projection =
            needed.iter().filter_map(|c| (0..descr.num_columns()).find(|&i| descr.column(i).name() == c)).collect();
        let col_idx = |name: &str| (0..descr.num_columns()).find(|&i| descr.column(i).name() == name);
        self.selected = (0..self.meta.num_row_groups())
            .filter(|&rg| {
                let rgm = self.meta.row_group(rg);
                let stat = |name: &str| col_idx(name).and_then(|i| rgm.column(i).statistics());
                let time_ok = match &spec.time_column {
                    Some(tc) => {
                        let (lo, hi) = int_range(stat(tc));
                        time_overlaps(lo, hi, spec)
                    }
                    None => true,
                };
                time_ok
                    && spec.series.iter().all(|(col, values)| {
                        let (lo, hi) = stat_bounds(stat(col));
                        values.is_empty() || values.iter().any(|v| may_contain(lo.as_ref(), hi.as_ref(), v))
                    })
            })
            .collect();
        let mut ranges: Vec<(u64, u64)> = vec![];
        for &rg in &self.selected {
            for &c in &self.projection {
                let (start, len) = self.meta.row_group(rg).column(c).byte_range();
                ranges.push((start, start + len));
            }
        }
        ranges.sort();
        let mut merged: Vec<(u64, u64)> = vec![];
        for (s, e) in ranges {
            match merged.last_mut() {
                Some(last) if s <= last.1 + 64 * 1024 => last.1 = last.1.max(e),
                _ => merged.push((s, e)),
            }
        }
        merged
    }

    pub fn add_range(&mut self, start: u64, bytes: Vec<u8>) {
        self.data.chunks.insert(start, Bytes::from(bytes));
    }

    /// Decodes the planned row groups and columns, applying the query's exact filters.
    pub fn read(&self, spec: &QuerySpec) -> Result<Vec<RecordBatch>, Error> {
        if self.selected.is_empty() {
            return Ok(vec![]);
        }
        let mask = ProjectionMask::leaves(self.meta.file_metadata().schema_descr(), self.projection.iter().copied());
        let reader = ParquetRecordBatchReaderBuilder::new_with_metadata(self.data.clone(), self.reader_meta.clone())
            .with_row_groups(self.selected.clone())
            .with_projection(mask)
            .with_batch_size(64 * 1024)
            .build()
            .map_err(|e| Error(format!("Parquet read: {e}")))?;
        let mut out = vec![];
        for b in reader {
            let b = b.map_err(|e| Error(format!("Parquet read: {e}")))?;
            let f = filter(&b, spec)?;
            if f.num_rows() > 0 {
                out.push(f);
            }
        }
        Ok(out)
    }
}

fn int_range(s: Option<&Statistics>) -> (Option<i64>, Option<i64>) {
    match s {
        Some(Statistics::Int64(v)) => (v.min_opt().copied(), v.max_opt().copied()),
        Some(Statistics::Int32(v)) => (v.min_opt().map(|x| *x as i64), v.max_opt().map(|x| *x as i64)),
        _ => (None, None),
    }
}

fn stat_bounds(s: Option<&Statistics>) -> (Option<Bound>, Option<Bound>) {
    match s {
        Some(Statistics::Int32(v)) => {
            (v.min_opt().map(|x| Bound::Int(*x as i64)), v.max_opt().map(|x| Bound::Int(*x as i64)))
        }
        Some(Statistics::Int64(v)) => (v.min_opt().map(|x| Bound::Int(*x)), v.max_opt().map(|x| Bound::Int(*x))),
        Some(Statistics::Double(v)) => (v.min_opt().map(|x| Bound::Float(*x)), v.max_opt().map(|x| Bound::Float(*x))),
        Some(Statistics::ByteArray(v)) => (
            v.min_opt().and_then(|x| x.as_utf8().ok()).map(|s| Bound::Str(s.to_string())),
            v.max_opt().and_then(|x| x.as_utf8().ok()).map(|s| Bound::Str(s.to_string())),
        ),
        _ => (None, None),
    }
}

// --- filtering ------------------------------------------------------------------------------------

fn micros(col: &ArrayRef) -> Result<Int64Array, Error> {
    let c = arrow_cast::cast(col, &DataType::Int64).map_err(|e| Error(e.to_string()))?;
    Ok(c.as_primitive::<Int64Type>().clone())
}

fn eq_any(col: &ArrayRef, values: &[Json]) -> Result<BooleanArray, Error> {
    let mut acc: Option<BooleanArray> = None;
    for v in values {
        let m = match (col.data_type(), v) {
            // A value the column can't hold (1.5, or 2^40 for int) matches no row.
            (DataType::Int32, Json::Number(n)) => match n.as_i64().and_then(|n| i32::try_from(n).ok()) {
                Some(n) => arrow_ord::cmp::eq(col, &Int32Array::new_scalar(n)),
                None => Ok(BooleanArray::from(vec![false; col.len()])),
            },
            (DataType::Int64, Json::Number(n)) => match n.as_i64() {
                Some(n) => arrow_ord::cmp::eq(col, &Int64Array::new_scalar(n)),
                None => Ok(BooleanArray::from(vec![false; col.len()])),
            },
            (DataType::Utf8, Json::String(s)) => arrow_ord::cmp::eq(col, &StringArray::new_scalar(s.as_str())),
            (_, v) => {
                let as_str = arrow_cast::cast(col, &DataType::Utf8).map_err(|e| Error(e.to_string()))?;
                let s = match v {
                    Json::String(s) => s.clone(),
                    other => other.to_string(),
                };
                arrow_ord::cmp::eq(&as_str, &StringArray::new_scalar(s))
            }
        }
        .map_err(|e| Error(e.to_string()))?;
        acc = Some(match acc {
            None => m,
            Some(a) => arrow_arith_or(&a, &m),
        });
    }
    Ok(acc.unwrap_or_else(|| BooleanArray::from(vec![true; col.len()])))
}

fn arrow_arith_or(a: &BooleanArray, b: &BooleanArray) -> BooleanArray {
    a.iter().zip(b.iter()).map(|(x, y)| Some(x.unwrap_or(false) || y.unwrap_or(false))).collect()
}

fn arrow_and(a: &BooleanArray, b: &BooleanArray) -> BooleanArray {
    a.iter().zip(b.iter()).map(|(x, y)| Some(x.unwrap_or(false) && y.unwrap_or(false))).collect()
}

fn filter(batch: &RecordBatch, spec: &QuerySpec) -> Result<RecordBatch, Error> {
    let mut mask: Option<BooleanArray> = None;
    let mut and = |m: BooleanArray| {
        mask = Some(match mask.take() {
            None => m,
            Some(a) => arrow_and(&a, &m),
        })
    };
    if let Some(tc) = &spec.time_column
        && (spec.from.is_some() || spec.to.is_some())
        && let Some(col) = batch.column_by_name(tc)
    {
        let t = micros(col)?;
        let m: BooleanArray =
            t.iter().map(|v| v.map(|v| spec.from.is_none_or(|f| v >= f) && spec.to.is_none_or(|e| v < e))).collect();
        and(m);
    }
    for (c, values) in &spec.series {
        if values.is_empty() {
            continue;
        }
        if let Some(col) = batch.column_by_name(c) {
            and(eq_any(col, values)?);
        }
    }
    match mask {
        None => Ok(batch.clone()),
        Some(m) => arrow_select::filter::filter_record_batch(batch, &m).map_err(|e| Error(e.to_string())),
    }
}

// --- results ----------------------------------------------------------------------------------------

/// Rows as JSON objects, ordered by time, limited and projected.
pub fn rows_json(batches: &[RecordBatch], spec: &QuerySpec) -> Result<String, Error> {
    if batches.is_empty() {
        return Ok("[]".into());
    }
    let schema = batches[0].schema();
    let all = arrow_select::concat::concat_batches(&schema, batches).map_err(|e| Error(e.to_string()))?;
    let sorted = match spec.time_column.as_ref().and_then(|tc| all.column_by_name(tc)) {
        Some(tc) => {
            let opts = arrow_schema::SortOptions { descending: spec.descending, nulls_first: false };
            let idx = arrow_ord::sort::sort_to_indices(tc, Some(opts), spec.limit).map_err(|e| Error(e.to_string()))?;
            arrow_select::take::take_record_batch(&all, &idx).map_err(|e| Error(e.to_string()))?
        }
        None => all,
    };
    let limited = match spec.limit {
        Some(n) if n < sorted.num_rows() => sorted.slice(0, n),
        _ => sorted,
    };
    let projected = if spec.columns.is_empty() {
        limited
    } else {
        let idx: Vec<usize> = spec.columns.iter().filter_map(|c| limited.schema().index_of(c).ok()).collect();
        limited.project(&idx).map_err(|e| Error(e.to_string()))?
    };
    let mut buf = vec![];
    let mut w =
        arrow_json::WriterBuilder::new().with_explicit_nulls(true).build::<_, arrow_json::writer::JsonArray>(&mut buf);
    w.write(&projected).map_err(|e| Error(e.to_string()))?;
    w.finish().map_err(|e| Error(e.to_string()))?;
    drop(w);
    String::from_utf8(buf).map_err(|e| Error(e.to_string()))
}

#[derive(Clone, Default)]
struct Acc {
    count: u64,
    sum: f64,
    min: Option<f64>,
    max: Option<f64>,
    first: Option<(i64, f64)>,
    last: Option<(i64, f64)>,
}

/// Group key: bucket start and the group-by values (as JSON text, for ordering).
type GroupKey = (i64, Vec<String>);
/// Group state: the group-by values and one accumulator per aggregate.
type GroupState = (Vec<Json>, Vec<Acc>);

/// Streaming time-bucket aggregation across files.
pub struct Aggregator {
    spec: BucketSpec,
    time_column: String,
    groups: BTreeMap<GroupKey, GroupState>,
}

fn json_at(col: &ArrayRef, i: usize) -> Json {
    if col.is_null(i) {
        return Json::Null;
    }
    match col.data_type() {
        DataType::Int8 | DataType::Int16 | DataType::Int32 | DataType::Int64 => {
            let c = arrow_cast::cast(&col.slice(i, 1), &DataType::Int64).ok();
            c.map(|c| Json::from(c.as_primitive::<Int64Type>().value(0))).unwrap_or(Json::Null)
        }
        DataType::Utf8 => Json::from(col.as_string::<i32>().value(i)),
        _ => arrow_cast::display::array_value_to_string(col, i).map(Json::from).unwrap_or(Json::Null),
    }
}

impl Aggregator {
    pub fn new(spec: BucketSpec, time_column: String) -> Result<Self, Error> {
        if spec.every <= 0 {
            return Err(Error("bucket width must be positive".into()));
        }
        Ok(Self { spec, time_column, groups: BTreeMap::new() })
    }

    pub fn push(&mut self, batch: &RecordBatch) -> Result<(), Error> {
        let t = micros(batch.column_by_name(&self.time_column).ok_or_else(|| Error("time column missing".into()))?)?;
        let by: Vec<ArrayRef> = self.spec.by.iter().filter_map(|c| batch.column_by_name(c).cloned()).collect();
        let vals: Vec<Option<arrow_array::Float64Array>> = self
            .spec
            .aggs
            .iter()
            .map(|a| {
                batch
                    .column_by_name(&a.column)
                    .and_then(|c| arrow_cast::cast(c, &DataType::Float64).ok())
                    .map(|c| c.as_primitive::<Float64Type>().clone())
            })
            .collect();
        let (every, origin) = (self.spec.every, self.spec.origin);
        for i in 0..batch.num_rows() {
            if t.is_null(i) {
                continue;
            }
            let ts = t.value(i);
            let bucket = (ts - origin).div_euclid(every) * every + origin;
            let key_vals: Vec<Json> = by.iter().map(|c| json_at(c, i)).collect();
            let key = (bucket, key_vals.iter().map(|v| v.to_string()).collect());
            let entry =
                self.groups.entry(key).or_insert_with(|| (key_vals, vec![Acc::default(); self.spec.aggs.len()]));
            for (j, a) in self.spec.aggs.iter().enumerate() {
                let acc = &mut entry.1[j];
                if a.column == "*" {
                    acc.count += 1;
                    continue;
                }
                let Some(Some(v)) = vals[j].as_ref().map(|c| (!c.is_null(i)).then(|| c.value(i))) else { continue };
                acc.count += 1;
                acc.sum += v;
                acc.min = Some(acc.min.map_or(v, |m| m.min(v)));
                acc.max = Some(acc.max.map_or(v, |m| m.max(v)));
                if acc.first.is_none_or(|(ft, _)| ts < ft) {
                    acc.first = Some((ts, v));
                }
                if acc.last.is_none_or(|(lt, _)| ts >= lt) {
                    acc.last = Some((ts, v));
                }
            }
        }
        Ok(())
    }

    pub fn finish(&self) -> String {
        let num = |v: Option<f64>| v.filter(|x| x.is_finite()).map(Json::from).unwrap_or(Json::Null);
        let rows: Vec<Json> = self
            .groups
            .iter()
            .map(|((bucket, _), (key_vals, accs))| {
                let mut o = serde_json::Map::new();
                o.insert("bucket".into(), Json::from(iso(*bucket)));
                for (c, v) in self.spec.by.iter().zip(key_vals) {
                    o.insert(c.clone(), v.clone());
                }
                for (a, acc) in self.spec.aggs.iter().zip(accs) {
                    let name = if a.column == "*" { "count".to_string() } else { format!("{}_{}", a.column, a.op) };
                    let v = match a.op.as_str() {
                        "count" => Json::from(acc.count),
                        "sum" => num((acc.count > 0).then_some(acc.sum)),
                        "avg" => num((acc.count > 0).then(|| acc.sum / acc.count as f64)),
                        "min" => num(acc.min),
                        "max" => num(acc.max),
                        "first" => num(acc.first.map(|x| x.1)),
                        "last" => num(acc.last.map(|x| x.1)),
                        _ => Json::Null,
                    };
                    o.insert(name, v);
                }
                Json::Object(o)
            })
            .collect();
        Json::Array(rows).to_string()
    }
}

/// RFC 3339 in UTC, like the engine's JSON output (`2026-01-03T23:00:00Z`).
pub fn iso(micros: i64) -> String {
    chrono::DateTime::from_timestamp_micros(micros)
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn int_filter_values_the_column_cannot_hold_match_nothing() {
        let col: ArrayRef = Arc::new(Int32Array::from(vec![0, 1, 2]));
        let matches = |v: Json| eq_any(&col, &[v]).unwrap().iter().map(|m| m == Some(true)).collect::<Vec<_>>();
        assert_eq!(matches(serde_json::json!(1)), [false, true, false]);
        assert_eq!(matches(serde_json::json!(1.5)), [false, false, false]);
        assert_eq!(matches(serde_json::json!(4_294_967_297_i64)), [false, false, false]);
    }
}
