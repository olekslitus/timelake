//! The write path: align incoming Arrow data to the table schema, sort it by
//! `(series_key…, time)`, split it by time partition, and write Parquet laid out for time series.

use std::sync::Arc;

use arrow::array::{Array, ArrayRef, Int32Array, RecordBatch, TimestampMicrosecondArray};
use arrow::compute::{cast, concat_batches, take_record_batch};
use arrow::datatypes::{DataType, TimeUnit};
use iceberg::spec::{DataContentType, DataFile, Literal, PrimitiveLiteral, Struct};
use iceberg::writer::CurrentFileStatus;
use iceberg::writer::file_writer::{FileWriter, FileWriterBuilder, ParquetWriterBuilder};
use parquet::basic::{Compression, Encoding, ZstdLevel};
use parquet::file::metadata::SortingColumn;
use parquet::file::properties::{EnabledStatistics, WriterProperties};
use parquet::schema::types::ColumnPath;

use crate::contract::Contract;
use crate::error::{Error, Result};
use crate::schema::align_batch;
use crate::sort::{ASCENDING, columns, stable_sort_indices};
use crate::storage::Uploads;
use crate::table::Table;

/// ZSTD level for data files and last-value indexes: fast to write, close to the best ratio.
pub(crate) const ZSTD_LEVEL: i32 = 3;

/// Rows of one time partition (`None` for unpartitioned tables), sorted by the table's sort key.
pub(crate) type PartitionRows = (Option<i32>, RecordBatch);

/// Concatenates, sorts by `(partition, series…, time)` with input order as the tiebreak, and splits
/// by partition.
pub(crate) fn sort_and_split(table: &Table, batches: &[RecordBatch]) -> Result<Vec<PartitionRows>> {
    let schema = table.schema();
    let aligned =
        batches.iter().filter(|b| b.num_rows() > 0).map(|b| align_batch(b, &schema)).collect::<Result<Vec<_>>>()?;
    if aligned.is_empty() {
        return Ok(vec![]);
    }
    let all = concat_batches(&schema, &aligned)?;
    let partitions = partition_values(&all, table.contract())?;
    let mut keys: Vec<ArrayRef> =
        partitions.iter().map(|p| Arc::new(Int32Array::from(p.clone())) as ArrayRef).collect();
    keys.extend(columns(&all, &table.contract().sort_columns())?);
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

/// Parquet settings for time-series data: ZSTD, page-level statistics and page index (for
/// row-group and page pruning), delta encoding for timestamps, byte-stream-split for floats,
/// dictionary encoding for everything else (series keys, tags), and the sort order recorded.
pub(crate) fn writer_properties(table: &Table) -> Result<WriterProperties> {
    let schema = table.schema();
    let contract = table.contract();
    let mut b = WriterProperties::builder()
        .set_compression(Compression::ZSTD(ZstdLevel::try_new(ZSTD_LEVEL)?))
        .set_max_row_group_row_count(Some(contract.row_group_rows))
        .set_statistics_enabled(EnabledStatistics::Page)
        .set_created_by(format!("timelake {}", env!("CARGO_PKG_VERSION")));
    for f in schema.fields() {
        let path = ColumnPath::from(f.name().as_str());
        match f.data_type() {
            DataType::Float32 | DataType::Float64 => {
                b = b
                    .set_column_dictionary_enabled(path.clone(), false)
                    .set_column_encoding(path, Encoding::BYTE_STREAM_SPLIT);
            }
            DataType::Timestamp(_, _) if Some(f.name()) == contract.time_column.as_ref() => {
                b = b
                    .set_column_dictionary_enabled(path.clone(), false)
                    .set_column_encoding(path, Encoding::DELTA_BINARY_PACKED);
            }
            _ => {}
        }
    }
    let sorting = contract
        .sort_columns()
        .iter()
        .map(|c| {
            let column_idx = i32::try_from(schema.index_of(c)?).map_err(|_| Error::invalid("too many columns"))?;
            Ok(SortingColumn { column_idx, descending: ASCENDING.descending, nulls_first: ASCENDING.nulls_first })
        })
        .collect::<Result<Vec<_>>>()?;
    if !sorting.is_empty() {
        b = b.set_sorting_columns(Some(sorting));
    }
    Ok(b.build())
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
    let contract = table.contract();
    let metadata = table.metadata();
    let builder = ParquetWriterBuilder::new(props.clone(), metadata.current_schema().clone());
    let dir = match (partition, &contract.time_column, contract.chunk) {
        (Some(v), Some(time_column), Some(chunk)) => {
            format!("{}/data/{time_column}_{chunk}={}", table.location(), chunk.label(v))
        }
        _ => format!("{}/data", table.location()),
    };
    let target = usize::try_from(contract.target_file_size).unwrap_or(usize::MAX);

    let mut files = vec![];
    let mut open = None;
    for batch in batches {
        if batch.num_rows() == 0 {
            continue;
        }
        let mut writer = if let Some(w) = open.take() {
            w
        } else {
            let uri = format!("{dir}/{}.parquet", uuid::Uuid::now_v7());
            builder.build(table.lake().storage().deferred_output_file(&uri, uploads)).await?
        };
        writer.write(&batch).await?;
        if writer.current_written_size() >= target {
            files.extend(writer.close().await?);
        } else {
            open = Some(writer);
        }
    }
    if let Some(writer) = open {
        files.extend(writer.close().await?);
    }

    let spec_id = metadata.default_partition_spec().spec_id();
    let sort_order_id = (!contract.sort_columns().is_empty())
        .then(|| i32::try_from(metadata.default_sort_order_id()))
        .transpose()
        .map_err(|_| Error::invalid("sort order id out of range"))?;
    files
        .into_iter()
        .map(|mut b| {
            b.content(DataContentType::Data).partition(partition_struct(partition)).partition_spec_id(spec_id);
            if let Some(id) = sort_order_id {
                b.sort_order_id(id);
            }
            b.build().map_err(|e| {
                iceberg::Error::new(iceberg::ErrorKind::Unexpected, "building data file").with_source(e).into()
            })
        })
        .collect()
}

fn partition_struct(v: Option<i32>) -> Struct {
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
