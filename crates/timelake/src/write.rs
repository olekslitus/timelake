//! The write path: align incoming Arrow data to the table schema, sort it by
//! `(series_key…, time)`, split it by time partition, and write Parquet laid out for time series.

use std::sync::Arc;

use arrow::array::{Array, ArrayRef, Int32Array, RecordBatch, TimestampMicrosecondArray};
use arrow::compute::kernels::zip::zip;
use arrow::compute::{cast, concat_batches, is_not_null, take_record_batch};
use arrow::datatypes::{DataType, Field, Schema, TimeUnit};
use std::collections::HashMap;

use iceberg::spec::{
    DataContentType, DataFile, DataFileBuilder, DataFileFormat, Datum, Literal, PrimitiveLiteral, Struct, Type,
};
use parquet::file::properties::WriterProperties;
use timelake_format::file::{FileStats, FileWriter};

use crate::contract::Contract;
use crate::error::{Error, Result};
use crate::schema::{UTC, align_batch};
use crate::sort::{columns, last_per_group, stable_sort_indices};
use crate::storage::{DeferredWriter, Uploads};
use crate::table::Table;

/// Rows of one time partition (`None` for unpartitioned tables), sorted by the table's sort key.
pub(crate) type PartitionRows = (Option<i32>, RecordBatch);

/// Concatenates, sorts by `(partition, series…, time)` with input order as the tiebreak, splits by
/// partition and, when dedup is on, keeps the last of rows with the same `(series…, time)`: every
/// file is then free of duplicates on its own, which dedup on read relies on.
pub(crate) fn sort_and_split(table: &Table, batches: &[RecordBatch]) -> Result<Vec<PartitionRows>> {
    let split = sort_and_split_all(table, batches)?;
    let keys = table.contract().sort_columns();
    if !table.contract().dedup || keys.is_empty() {
        return Ok(split);
    }
    split.into_iter().map(|(p, rows)| Ok((p, last_per_group(&rows, &keys)?))).collect()
}

fn sort_and_split_all(table: &Table, batches: &[RecordBatch]) -> Result<Vec<PartitionRows>> {
    let schema = table.schema();
    let now = chrono::Utc::now().timestamp_micros();
    let ingest = table.contract().ingest_time_column.as_deref();
    let aligned = batches
        .iter()
        .filter(|b| b.num_rows() > 0)
        .map(|b| align_batch(&ingest.map_or_else(|| Ok(b.clone()), |c| with_ingest_time(b, c, now))?, &schema))
        .collect::<Result<Vec<_>>>()?;
    if aligned.is_empty() {
        return Ok(vec![]);
    }
    let all = concat_batches(&schema, &aligned)?;
    let partitions = partition_values(&all, table.contract())?;
    let mut keys: Vec<ArrayRef> =
        partitions.iter().map(|p| Arc::new(Int32Array::from(p.clone())) as ArrayRef).collect();
    keys.extend(columns(&all, &table.contract().write_order())?);
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

/// `batch` with its insertion-time `column` set to `now` (µs since the epoch) where it is missing or
/// null; values a caller supplied (an import keeping arrival times) stay.
pub(crate) fn with_ingest_time(batch: &RecordBatch, column: &str, now: i64) -> Result<RecordBatch> {
    let n = batch.num_rows();
    let fill = || Arc::new(TimestampMicrosecondArray::from_value(now, n).with_timezone(UTC)) as ArrayRef;
    let schema = batch.schema();
    let Ok(i) = schema.index_of(column) else {
        let mut fields: Vec<_> = schema.fields().iter().cloned().collect();
        fields.push(Arc::new(Field::new(column, DataType::Timestamp(TimeUnit::Microsecond, Some(UTC.into())), false)));
        let mut columns = batch.columns().to_vec();
        columns.push(fill());
        return Ok(RecordBatch::try_new(Arc::new(Schema::new(fields)), columns)?);
    };
    if batch.column(i).null_count() == 0 {
        return Ok(batch.clone());
    }
    let given = cast(batch.column(i), &DataType::Timestamp(TimeUnit::Microsecond, Some(UTC.into())))?;
    let filled = zip(&is_not_null(&given)?, &given, &fill())?;
    let mut fields: Vec<_> = schema.fields().iter().cloned().collect();
    fields[i] = Arc::new(Field::new(column, filled.data_type().clone(), false));
    let mut columns = batch.columns().to_vec();
    columns[i] = filled;
    Ok(RecordBatch::try_new(Arc::new(Schema::new(fields)), columns)?)
}

/// Partition value of every row (`None` for unpartitioned tables).
fn partition_values(batch: &RecordBatch, contract: &Contract) -> Result<Option<Vec<i32>>> {
    let (Some(time_column), Some(chunk)) = (&contract.time_column, contract.chunk) else { return Ok(None) };
    let times =
        cast(batch.column(batch.schema().index_of(time_column)?), &DataType::Timestamp(TimeUnit::Microsecond, None))?;
    let Some(times) = times.as_any().downcast_ref::<TimestampMicrosecondArray>() else {
        return Err(Error::invalid(format!("time column {time_column:?} is not a timestamp")));
    };
    if times.null_count() > 0 {
        return Err(Error::invalid(format!("time column {time_column:?} contains nulls")));
    }
    let values = times.values().iter().map(|&t| chunk.value(t)).collect::<timelake_format::Result<_>>()?;
    Ok(Some(values))
}

/// Parquet settings for the table's data files (see `timelake_format::file::writer_properties`).
pub(crate) fn writer_properties(table: &Table) -> Result<WriterProperties> {
    let created_by = format!("timelake {}", env!("CARGO_PKG_VERSION"));
    Ok(timelake_format::file::writer_properties(&table.schema(), table.contract(), &created_by)?)
}

/// Partition value of a data file written by Timelake (`None` if unpartitioned).
pub fn file_partition(df: &DataFile) -> Option<i32> {
    match df.partition().fields().first() {
        Some(Some(Literal::Primitive(PrimitiveLiteral::Int(v)))) => Some(*v),
        _ => None,
    }
}

/// Writes already-sorted batches of one partition, rolling to a new file at the target size. The
/// end of each file's upload is queued in `uploads`, to be sent with the commit's metadata.
pub(crate) async fn write_partition(
    table: &Table,
    partition: Option<i32>,
    batches: impl IntoIterator<Item = RecordBatch>,
    props: &WriterProperties,
    uploads: &Uploads,
) -> Result<Vec<DataFile>> {
    let mut writer = PartitionWriter::new(table, partition, props, uploads);
    for batch in batches {
        writer.write(&batch).await?;
    }
    writer.finish().await
}

/// Writes sorted batches of one partition as they come, rolling to a new file at the target size
/// (see [`write_partition`]). Files are encoded by the shared writer (`timelake_format::file`),
/// columns in parallel, and stream out as multipart uploads, so memory is the row group being
/// encoded.
pub(crate) struct PartitionWriter<'a> {
    table: &'a Table,
    partition: Option<i32>,
    props: WriterProperties,
    uploads: &'a Uploads,
    dir: String,
    target: u64,
    open: Option<(String, FileWriter, DeferredWriter)>,
    files: Vec<DataFile>,
}

impl<'a> PartitionWriter<'a> {
    pub(crate) fn new(
        table: &'a Table,
        partition: Option<i32>,
        props: &WriterProperties,
        uploads: &'a Uploads,
    ) -> Self {
        let contract = table.contract();
        let dir = match (partition, &contract.time_column, contract.chunk) {
            (Some(v), Some(time_column), Some(chunk)) => {
                format!("{}/data/{time_column}_{chunk}={}", table.location(), chunk.label(v))
            }
            _ => format!("{}/data", table.location()),
        };
        let props = props.clone();
        Self { table, partition, props, uploads, dir, target: contract.target_file_size, open: None, files: vec![] }
    }

    /// Writes rows that sort after every row written so far.
    pub(crate) async fn write(&mut self, batch: &RecordBatch) -> Result<()> {
        if batch.num_rows() == 0 {
            return Ok(());
        }
        let (uri, mut writer, mut upload) = if let Some(open) = self.open.take() {
            open
        } else {
            let uri = format!("{}/{}.parquet", self.dir, uuid::Uuid::now_v7());
            let writer = FileWriter::new(self.table.schema(), self.props.clone())?;
            let upload = self.table.lake().storage().deferred_writer(&uri, self.uploads)?;
            (uri, writer, upload)
        };
        writer.write(batch)?;
        upload.put(writer.take()).await?;
        if writer.size() >= self.target {
            self.close(uri, writer, upload).await?;
        } else {
            self.open = Some((uri, writer, upload));
        }
        Ok(())
    }

    async fn close(&mut self, uri: String, writer: FileWriter, mut upload: DeferredWriter) -> Result<()> {
        let (rest, stats) = writer.finish()?;
        upload.put(rest).await?;
        upload.close();
        self.files.push(data_file(self.table, uri, self.partition, &stats)?);
        Ok(())
    }

    /// Closes the last file; returns the files written.
    pub(crate) async fn finish(mut self) -> Result<Vec<DataFile>> {
        if let Some((uri, writer, upload)) = self.open.take() {
            self.close(uri, writer, upload).await?;
        }
        Ok(self.files)
    }
}

/// The Iceberg entry of a data file the shared writer wrote, with the statistics iceberg-rust's
/// writer would record.
fn data_file(table: &Table, uri: String, partition: Option<i32>, stats: &FileStats) -> Result<DataFile> {
    let metadata = table.metadata();
    let schema = metadata.current_schema();
    let datums = |bounds: &std::collections::BTreeMap<i32, Vec<u8>>| -> Result<HashMap<i32, Datum>> {
        let mut out = HashMap::new();
        for (id, bytes) in bounds {
            if let Some(Type::Primitive(ty)) = schema.field_by_id(*id).map(|f| f.field_type.as_ref()) {
                out.insert(*id, Datum::try_from_bytes(bytes, ty.clone())?);
            }
        }
        Ok(out)
    };
    let counts = |m: &std::collections::BTreeMap<i32, u64>| m.iter().map(|(k, v)| (*k, *v)).collect::<HashMap<_, _>>();
    let mut b = DataFileBuilder::default();
    b.content(DataContentType::Data)
        .file_path(uri)
        .file_format(DataFileFormat::Parquet)
        .partition(partition_struct(partition))
        .partition_spec_id(metadata.default_partition_spec().spec_id())
        .record_count(stats.record_count)
        .file_size_in_bytes(stats.file_size)
        .column_sizes(counts(&stats.column_sizes))
        .value_counts(counts(&stats.value_counts))
        .null_value_counts(counts(&stats.null_counts))
        .nan_value_counts(counts(&stats.nan_counts))
        .lower_bounds(datums(&stats.lower_bounds)?)
        .upper_bounds(datums(&stats.upper_bounds)?)
        .split_offsets(Some(stats.split_offsets.clone()));
    if !table.contract().sort_columns().is_empty() {
        let id = i32::try_from(metadata.default_sort_order_id())
            .map_err(|_| Error::invalid("sort order id out of range"))?;
        b.sort_order_id(id);
    }
    b.build()
        .map_err(|e| iceberg::Error::new(iceberg::ErrorKind::Unexpected, "building data file").with_source(e).into())
}

pub(crate) fn partition_struct(v: Option<i32>) -> Struct {
    match v {
        Some(v) => Struct::from_iter([Some(Literal::int(v))]),
        None => Struct::empty(),
    }
}

/// Splits a large batch into slices of `rows` rows (one Parquet row group each), so the writer
/// streams them.
pub(crate) fn row_groups(batch: RecordBatch, rows: usize) -> impl Iterator<Item = RecordBatch> {
    let n = batch.num_rows();
    (0..n).step_by(rows.max(1)).map(move |i| batch.slice(i, rows.min(n - i)))
}

#[cfg(test)]
mod tests {
    use iceberg::writer::file_writer::{FileWriter as _, FileWriterBuilder, ParquetWriterBuilder};

    use super::*;
    use crate::testing::{T0, batch, faulty_lake, opts, schema};

    /// The shared writer records what iceberg-rust's writer records for the same rows, and writes
    /// the same bytes.
    #[tokio::test]
    async fn shared_writer_matches_iceberg_rust() {
        let (lake, _store) = faulty_lake();
        let t = lake.create_table("iot.r", &schema(), opts()).await.unwrap();
        let rows: Vec<(i64, i32, f64)> = (0..50_000)
            .map(|i| (T0 + i64::from(i), i % 9, if i % 7 == 0 { f64::NAN } else { f64::from(i) / 3.0 }))
            .collect();
        let (partition, sorted) = sort_and_split(&t, &[batch(&rows)]).unwrap().remove(0);
        let props = writer_properties(&t).unwrap();

        let uploads = Uploads::default();
        let ours = write_partition(&t, partition, [sorted.clone()], &props, &uploads).await.unwrap().remove(0);
        uploads.send().await.unwrap();

        let builder = ParquetWriterBuilder::new(props, t.metadata().current_schema().clone());
        let uri = format!("{}/data/theirs.parquet", t.location());
        let mut writer = builder.build(lake.storage().deferred_output_file(&uri, &uploads)).await.unwrap();
        writer.write(&sorted).await.unwrap();
        let theirs = writer.close().await.unwrap().remove(0).partition(partition_struct(partition)).build().unwrap();
        uploads.send().await.unwrap();

        assert_eq!(ours.record_count(), theirs.record_count());
        assert_eq!(ours.file_size_in_bytes(), theirs.file_size_in_bytes());
        assert_eq!(ours.column_sizes(), theirs.column_sizes());
        assert_eq!(ours.value_counts(), theirs.value_counts());
        assert_eq!(ours.null_value_counts(), theirs.null_value_counts());
        assert_eq!(ours.nan_value_counts(), theirs.nan_value_counts());
        assert_eq!(ours.lower_bounds(), theirs.lower_bounds());
        assert_eq!(ours.upper_bounds(), theirs.upper_bounds());
        assert_eq!(ours.split_offsets(), theirs.split_offsets());
        let storage = lake.storage();
        assert_eq!(storage.read(ours.file_path()).await.unwrap(), storage.read(theirs.file_path()).await.unwrap());
    }
}
