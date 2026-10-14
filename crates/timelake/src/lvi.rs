//! Last-value index: one small Parquet file per snapshot holding the latest row of every series.
//!
//! "Current state of every device" is the most common IoT query and the one where lakes lose to
//! TimescaleDB by ~100× (SPEC §17.5): a generic engine has to scan everything to find each
//! series' newest row. The index makes it a single small read. It is maintained incrementally on
//! every append (previous index ⊕ newest rows of the appended data), referenced from the snapshot
//! summary (`timelake.last-value-index`), and plain Parquet, so DuckDB can read it too.

use std::sync::Arc;

use arrow::array::{RecordBatch, UInt32Array};
use arrow::compute::{SortColumn, SortOptions, concat_batches, lexsort_to_indices, take_record_batch};
use arrow::datatypes::SchemaRef;
use bytes::Bytes;
use parquet::arrow::ArrowWriter;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use parquet::basic::{Compression, ZstdLevel};
use parquet::file::properties::WriterProperties;

use crate::contract::Contract;
use crate::error::Result;
use crate::lake::Table;
use crate::write::align_batch;

/// Newest row per series among `batches`. On equal times, the later row wins (later input
/// position), matching dedup's "latest write wins".
pub fn latest_per_series(
    schema: &SchemaRef,
    contract: &Contract,
    batches: &[RecordBatch],
) -> Result<Option<RecordBatch>> {
    let Some(tc) = &contract.time_column else { return Ok(None) };
    if batches.iter().all(|b| b.num_rows() == 0) {
        return Ok(None);
    }
    let all = concat_batches(schema, batches)?;
    let mut keys = vec![];
    for c in contract.series_key.iter().chain(std::iter::once(tc)) {
        keys.push(SortColumn {
            values: all.column(schema.index_of(c)?).clone(),
            options: Some(SortOptions { descending: false, nulls_first: true }),
        });
    }
    keys.push(SortColumn { values: Arc::new(UInt32Array::from_iter_values(0..all.num_rows() as u32)), options: None });
    let sorted = take_record_batch(&all, &lexsort_to_indices(&keys, None)?)?;
    let n = sorted.num_rows();
    let last: Vec<u32> = if contract.series_key.is_empty() {
        vec![(n - 1) as u32]
    } else {
        let key_cols: Vec<_> = contract
            .series_key
            .iter()
            .map(|c| Ok(sorted.column(schema.index_of(c)?).clone()))
            .collect::<Result<_>>()?;
        let ranges = arrow::compute::partition(&key_cols)?.ranges();
        ranges.iter().map(|r| (r.end - 1) as u32).collect()
    };
    Ok(Some(take_record_batch(&sorted, &UInt32Array::from(last))?))
}

pub(crate) async fn read(table: &Table, uri: &str) -> Result<RecordBatch> {
    if let Some(b) = table.lake.cached_lvi(uri) {
        return Ok(b);
    }
    let bytes = table.lake.storage().read(uri).await?;
    let schema = table.schema();
    let reader = ParquetRecordBatchReaderBuilder::try_new(bytes)?.build()?;
    let batches =
        reader.map(|b| b.map_err(Into::into).and_then(|b| align_batch(&b, &schema))).collect::<Result<Vec<_>>>()?;
    let batch = concat_batches(&schema, &batches)?;
    table.lake.cache_lvi(uri.to_string(), batch.clone());
    Ok(batch)
}

pub(crate) async fn write(table: &Table, snapshot_id: i64, batch: &RecordBatch) -> Result<String> {
    let uri = format!("{}/metadata/lvi-{snapshot_id}-{}.parquet", table.location, uuid::Uuid::new_v4());
    let props = WriterProperties::builder().set_compression(Compression::ZSTD(ZstdLevel::try_new(3)?)).build();
    let mut buf = vec![];
    let mut w = ArrowWriter::try_new(&mut buf, batch.schema(), Some(props))?;
    w.write(batch)?;
    w.close()?;
    table.lake.storage().write(&uri, Bytes::from(buf)).await?;
    Ok(uri)
}

/// The index for a new snapshot: the base snapshot's index merged with the newest rows of the
/// appended data. `None` if the table has no time column.
pub(crate) async fn merged(base: &Table, delta: &RecordBatch) -> Result<Option<RecordBatch>> {
    let schema = base.schema();
    let mut parts = vec![];
    if let Some(uri) = base.last_value_index() {
        parts.push(read(base, &uri).await?);
    }
    parts.push(delta.clone());
    latest_per_series(&schema, &base.contract, &parts)
}
