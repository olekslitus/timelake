//! The write path: align incoming Arrow data to the table schema, sort it by
//! `(series_key…, time)`, split it by time partition, and write Parquet laid out for time series.

use std::sync::Arc;

use arrow::array::{Array, ArrayRef, RecordBatch, TimestampMicrosecondArray, UInt32Array, new_null_array};
use arrow::compute::{SortColumn, SortOptions, cast, concat_batches, lexsort_to_indices, take_record_batch};
use arrow::datatypes::{DataType, SchemaRef};
use iceberg::spec::{DataContentType, DataFile, Literal, PrimitiveLiteral, Struct};
use iceberg::writer::file_writer::{FileWriter, FileWriterBuilder, ParquetWriterBuilder};
use iceberg::writer::CurrentFileStatus;
use parquet::basic::{Compression, Encoding, ZstdLevel};
use parquet::file::metadata::SortingColumn;
use parquet::file::properties::{EnabledStatistics, WriterProperties};
use parquet::schema::types::ColumnPath;

use crate::contract::Contract;
use crate::error::{Error, Result};
use crate::lake::Table;

/// Casts and reorders a batch to the table schema by column name. Missing nullable columns are
/// filled with nulls; extra columns are an error (add them to the schema first).
pub fn align_batch(batch: &RecordBatch, schema: &SchemaRef) -> Result<RecordBatch> {
    let input = batch.schema();
    for f in input.fields() {
        if schema.field_with_name(f.name()).is_err() {
            return Err(Error::invalid(format!("column {:?} is not in the table schema", f.name())));
        }
    }
    let columns = schema
        .fields()
        .iter()
        .map(|f| match input.index_of(f.name()) {
            Ok(i) => {
                let col = batch.column(i);
                if col.data_type() == f.data_type() {
                    Ok(col.clone())
                } else {
                    Ok(cast(col, f.data_type())?)
                }
            }
            Err(_) if f.is_nullable() => Ok(new_null_array(f.data_type(), batch.num_rows())),
            Err(_) => Err(Error::invalid(format!("required column {:?} is missing", f.name()))),
        })
        .collect::<Result<Vec<ArrayRef>>>()?;
    RecordBatch::try_new(schema.clone(), columns).map_err(|e| Error::invalid(format!("batch does not fit the table schema: {e}")))
}

/// Sort options for the series key and time columns.
fn sort_columns(batch: &RecordBatch, cols: &[String]) -> Result<Vec<SortColumn>> {
    cols.iter()
        .map(|c| {
            Ok(SortColumn {
                values: batch.column(batch.schema().index_of(c)?).clone(),
                options: Some(SortOptions { descending: false, nulls_first: true }),
            })
        })
        .collect()
}

/// Partition value of every row (None for unpartitioned tables).
fn partition_values(batch: &RecordBatch, contract: &Contract) -> Result<Option<Vec<i32>>> {
    let (Some(tc), Some(chunk)) = (&contract.time_column, contract.chunk) else { return Ok(None) };
    let col = batch.column(batch.schema().index_of(tc)?);
    let ts = cast(col, &DataType::Timestamp(arrow::datatypes::TimeUnit::Microsecond, None))?;
    let ts = ts.as_any().downcast_ref::<TimestampMicrosecondArray>().unwrap();
    if ts.null_count() > 0 {
        return Err(Error::invalid(format!("time column {tc:?} contains nulls")));
    }
    Ok(Some(ts.values().iter().map(|&t| chunk.value(t)).collect()))
}

/// Concatenates, sorts by `(partition, series…, time)`, and splits by partition.
pub(crate) fn sort_and_split(table: &Table, batches: &[RecordBatch]) -> Result<Vec<(Option<i32>, RecordBatch)>> {
    let schema = table.schema();
    let aligned = batches.iter().filter(|b| b.num_rows() > 0).map(|b| align_batch(b, &schema)).collect::<Result<Vec<_>>>()?;
    if aligned.is_empty() {
        return Ok(vec![]);
    }
    let all = concat_batches(&schema, &aligned)?;
    let parts = partition_values(&all, &table.contract)?;
    let mut keys = vec![];
    if let Some(p) = &parts {
        keys.push(SortColumn { values: Arc::new(arrow::array::Int32Array::from(p.clone())), options: None });
    }
    keys.extend(sort_columns(&all, &table.contract.sort_columns())?);
    let sorted = if keys.is_empty() {
        all
    } else {
        // Stable tiebreak on input order, so later rows of the same (series, time) stay later.
        keys.push(SortColumn { values: Arc::new(UInt32Array::from_iter_values(0..all.num_rows() as u32)), options: None });
        take_record_batch(&all, &lexsort_to_indices(&keys, None)?)?
    };
    let Some(parts) = parts else { return Ok(vec![(None, sorted)]) };
    let mut sorted_parts = parts;
    sorted_parts.sort_unstable();
    let mut out = vec![];
    let mut start = 0;
    while start < sorted_parts.len() {
        let v = sorted_parts[start];
        let end = start + sorted_parts[start..].partition_point(|&x| x == v);
        out.push((Some(v), sorted.slice(start, end - start)));
        start = end;
    }
    Ok(out)
}

/// Parquet settings for time-series data: ZSTD, page-level statistics and page index (for
/// row-group and page pruning), delta encoding for timestamps, byte-stream-split for floats,
/// dictionary encoding for everything else (series keys, tags), and the sort order recorded.
pub(crate) fn writer_properties(table: &Table) -> Result<WriterProperties> {
    let schema = table.schema();
    let mut b = WriterProperties::builder()
        .set_compression(Compression::ZSTD(ZstdLevel::try_new(3)?))
        .set_max_row_group_row_count(Some(table.contract.row_group_rows))
        .set_statistics_enabled(EnabledStatistics::Page)
        .set_created_by(format!("timelake {}", env!("CARGO_PKG_VERSION")));
    for f in schema.fields() {
        let path = ColumnPath::from(f.name().as_str());
        match f.data_type() {
            DataType::Float32 | DataType::Float64 => {
                b = b.set_column_dictionary_enabled(path.clone(), false).set_column_encoding(path, Encoding::BYTE_STREAM_SPLIT);
            }
            DataType::Timestamp(_, _) if Some(f.name()) == table.contract.time_column.as_ref() => {
                b = b.set_column_dictionary_enabled(path.clone(), false).set_column_encoding(path, Encoding::DELTA_BINARY_PACKED);
            }
            _ => {}
        }
    }
    let sorting = table
        .contract
        .sort_columns()
        .iter()
        .map(|c| Ok(SortingColumn { column_idx: schema.index_of(c)? as i32, descending: false, nulls_first: true }))
        .collect::<Result<Vec<_>>>()?;
    if !sorting.is_empty() {
        b = b.set_sorting_columns(Some(sorting));
    }
    Ok(b.build())
}

fn partition_struct(v: Option<i32>) -> Struct {
    match v {
        Some(v) => Struct::from_iter([Some(Literal::int(v))]),
        None => Struct::empty(),
    }
}

/// Partition value of a data file written by Timelake (None if unpartitioned).
pub fn file_partition(df: &DataFile) -> Option<i32> {
    match df.partition().fields().first() {
        Some(Some(Literal::Primitive(PrimitiveLiteral::Int(v)))) => Some(*v),
        _ => None,
    }
}

/// Writes already-sorted batches of one partition, rolling to a new file at the target size.
pub(crate) async fn write_partition(
    table: &Table,
    partition: Option<i32>,
    batches: impl IntoIterator<Item = RecordBatch>,
    props: &WriterProperties,
) -> Result<Vec<DataFile>> {
    let storage = table.lake.storage();
    let builder = ParquetWriterBuilder::new(props.clone(), table.metadata.current_schema().clone());
    let dir = match (partition, &table.contract.time_column, table.contract.chunk) {
        (Some(v), Some(tc), Some(chunk)) => format!("{}/data/{tc}_{}={}", table.location, chunk.as_str(), chunk.label(v)),
        _ => format!("{}/data", table.location),
    };
    let spec_id = table.metadata.default_partition_spec().spec_id();
    let sorted = !table.contract.sort_columns().is_empty();
    let target = table.contract.target_file_size as usize;

    let mut out = vec![];
    let mut writer = None;
    for batch in batches {
        if batch.num_rows() == 0 {
            continue;
        }
        if writer.is_none() {
            let uri = format!("{dir}/{}.parquet", uuid::Uuid::now_v7());
            writer = Some(builder.build(storage.output_file(&uri)).await?);
        }
        let w = writer.as_mut().unwrap();
        w.write(&batch).await?;
        if w.current_written_size() >= target {
            out.extend(writer.take().unwrap().close().await?);
        }
    }
    if let Some(w) = writer {
        out.extend(w.close().await?);
    }
    out.into_iter()
        .map(|mut b| {
            b.content(DataContentType::Data).partition(partition_struct(partition)).partition_spec_id(spec_id);
            if sorted {
                b.sort_order_id(table.metadata.default_sort_order_id() as i32);
            }
            b.build().map_err(|e| Error::invalid(format!("data file: {e}")))
        })
        .collect()
}

/// Splits a large batch into row-group-sized slices so the Parquet writer streams them.
pub(crate) fn chunks(batch: RecordBatch, rows: usize) -> impl Iterator<Item = RecordBatch> {
    let n = batch.num_rows();
    (0..n).step_by(rows.max(1)).map(move |i| batch.slice(i, rows.min(n - i)))
}
