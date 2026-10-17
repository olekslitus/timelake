//! Appends for the shared write path (the WASM writer): rows are prepared as the engine prepares
//! them ([`crate::rows`]), written with the shared Parquet writer ([`crate::file`]) and committed
//! with the engine's protocol ([`crate::commit`]).

use std::collections::HashMap;

use arrow_array::RecordBatch;
use parquet::file::metadata::{ParquetMetaData, ParquetMetaDataWriter};

use crate::commit::{Change, CommitInfo, commit};
use crate::error::WriteResult;
use crate::file::{FileStats, FileWriter, writer_properties};
use crate::host::{Host, Upload, uuid_v7};
use crate::iceberg::DataFile;
use crate::rows::{latest_per_series, sort_and_split};
use crate::summary;
use crate::table::TableState;

/// Bytes sent per part of a multipart upload (S3 and R2 take parts of 5 MiB or more).
pub const PART_BYTES: usize = 8 << 20;

/// Options for [`append`].
#[derive(Clone, Debug, Default)]
pub struct AppendOptions {
    /// Idempotency key: appending the same batch id twice commits once.
    pub batch_id: Option<String>,
    /// Extra snapshot summary properties.
    pub properties: HashMap<String, String>,
}

/// What [`append`] did.
#[derive(Clone, Debug, Default)]
pub struct AppendReport {
    /// Rows committed (after in-append dedup); 0 for a duplicate batch.
    pub rows: usize,
    /// Data files committed.
    pub files: usize,
    /// Bytes of data files committed.
    pub bytes: u64,
    /// The commit.
    pub commit: CommitInfo,
}

/// Appends `batches` to `table` as one commit; returns the new version.
pub async fn append<H: Host>(
    host: &H,
    table: TableState,
    batches: &[RecordBatch],
    opts: &AppendOptions,
) -> WriteResult<(TableState, AppendReport)> {
    let now_us = host.now_ms().saturating_mul(1000);
    let partitions = sort_and_split(&table.schema, &table.contract, batches, now_us)?;
    let rows = partitions.iter().map(|(_, b)| b.num_rows()).sum();
    let latest = latest_per_series(
        &table.schema,
        &table.contract,
        &partitions.iter().map(|(_, b)| b.clone()).collect::<Vec<_>>(),
    )?;
    let mut files = vec![];
    let mut footers = vec![];
    let result = async {
        for (partition, batch) in &partitions {
            for (file, footer) in write_files(host, &table, *partition, batch).await? {
                footers.push((file.path.clone(), footer));
                files.push(file);
            }
        }
        Ok::<_, crate::error::WriteError>(())
    }
    .await;
    let paths: Vec<String> = files.iter().map(|f: &DataFile| f.path.clone()).collect();
    if let Err(e) = result {
        let _ = host.delete(&paths).await;
        return Err(e);
    }
    if files.is_empty() {
        let info = CommitInfo { version: table.version, ..CommitInfo::default() };
        return Ok((table, AppendReport { commit: info, ..AppendReport::default() }));
    }
    let (n_files, bytes) = (files.len(), files.iter().map(|f| f.file_size).sum());
    let mut props = opts.properties.clone();
    if let Some(id) = &opts.batch_id {
        props.insert(summary::BATCH_ID.into(), id.clone());
    }
    let committed = commit(host, table, &Change::Append { files, latest }, &props).await;
    if !matches!(&committed, Ok((_, info)) if !info.duplicate) {
        // Nothing references the data files.
        let _ = host.delete(&paths).await;
    }
    let (mut table, info) = committed?;
    if info.duplicate {
        return Ok((table, AppendReport { commit: info, ..AppendReport::default() }));
    }
    table.footers.extend(footers);
    let _ = table.write_head(host).await;
    Ok((table, AppendReport { rows, files: n_files, bytes, commit: info }))
}

/// Writes the sorted rows of one partition as data files of the table's target size, each with its
/// encoded footer (for the head).
pub async fn write_files<H: Host>(
    host: &H,
    table: &TableState,
    partition: Option<i32>,
    rows: &RecordBatch,
) -> WriteResult<Vec<(DataFile, Vec<u8>)>> {
    let mut writer = PartitionFiles::new(host, table, partition)?;
    writer.write(rows).await?;
    writer.finish().await
}

/// Writes sorted batches of one partition into files of the target size, uploading as they grow.
pub struct PartitionFiles<'a, H: Host> {
    host: &'a H,
    table: &'a TableState,
    partition: Option<i32>,
    open: Option<OpenFile<H::Upload>>,
    done: Vec<(DataFile, Vec<u8>)>,
}

impl<H: Host> std::fmt::Debug for PartitionFiles<'_, H> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PartitionFiles").field("partition", &self.partition).finish_non_exhaustive()
    }
}

struct OpenFile<U> {
    uri: String,
    writer: FileWriter,
    /// Encoded bytes not sent yet.
    pending: Vec<u8>,
    upload: Option<U>,
}

impl<'a, H: Host> PartitionFiles<'a, H> {
    /// A writer of `partition`'s files for `table`.
    pub fn new(host: &'a H, table: &'a TableState, partition: Option<i32>) -> WriteResult<Self> {
        Ok(Self { host, table, partition, open: None, done: vec![] })
    }

    fn dir(&self) -> String {
        let c = &self.table.contract;
        match (self.partition, &c.time_column, c.chunk) {
            (Some(v), Some(time_column), Some(chunk)) => {
                format!("{}/data/{time_column}_{chunk}={}", self.table.location, chunk.label(v))
            }
            _ => format!("{}/data", self.table.location),
        }
    }

    /// Writes rows that sort after every row written so far.
    pub async fn write(&mut self, batch: &RecordBatch) -> WriteResult<()> {
        if batch.num_rows() == 0 {
            return Ok(());
        }
        let mut file = if let Some(f) = self.open.take() {
            f
        } else {
            let props = writer_properties(&self.table.schema, &self.table.contract, &created_by())?;
            OpenFile {
                uri: format!("{}/{}.parquet", self.dir(), uuid_v7(self.host)),
                writer: FileWriter::new(self.table.schema.clone(), props)?,
                pending: vec![],
                upload: None,
            }
        };
        file.writer.write(batch)?;
        file.pending.extend(file.writer.take());
        if file.pending.len() >= PART_BYTES {
            let upload = match file.upload.take() {
                Some(u) => u,
                None => self.host.upload(&file.uri).await?,
            };
            let mut upload = upload;
            upload.put_part(std::mem::take(&mut file.pending)).await?;
            file.upload = Some(upload);
        }
        if file.writer.size() >= self.table.contract.target_file_size {
            self.close(file).await?;
        } else {
            self.open = Some(file);
        }
        Ok(())
    }

    async fn close(&mut self, file: OpenFile<H::Upload>) -> WriteResult<()> {
        let OpenFile { uri, writer, mut pending, upload } = file;
        let (rest, stats) = writer.finish()?;
        pending.extend(rest);
        match upload {
            Some(mut u) => {
                u.put_part(pending).await?;
                u.complete().await?;
            }
            None => self.host.put(&uri, pending).await?,
        }
        let footer = footer_bytes(&stats.metadata)?;
        self.done.push((data_file(self.table, uri, self.partition, &stats), footer));
        Ok(())
    }

    /// Closes the last file; returns the files written with their footers.
    pub async fn finish(mut self) -> WriteResult<Vec<(DataFile, Vec<u8>)>> {
        if let Some(file) = self.open.take() {
            self.close(file).await?;
        }
        Ok(self.done)
    }
}

/// What data files record as their writer: the same as the engine's, so files are identical.
fn created_by() -> String {
    format!("timelake {}", env!("CARGO_PKG_VERSION"))
}

/// The Iceberg entry of a written file.
pub fn data_file(table: &TableState, uri: String, partition: Option<i32>, stats: &FileStats) -> DataFile {
    DataFile {
        path: uri,
        partition,
        record_count: stats.record_count,
        file_size: stats.file_size,
        column_sizes: stats.column_sizes.clone(),
        value_counts: stats.value_counts.clone(),
        null_counts: stats.null_counts.clone(),
        nan_counts: stats.nan_counts.clone(),
        lower_bounds: stats.lower_bounds.clone(),
        upper_bounds: stats.upper_bounds.clone(),
        split_offsets: Some(stats.split_offsets.clone()),
        sort_order_id: (!table.contract.sort_columns().is_empty()).then(|| table.metadata.sort_order_id()),
    }
}

/// A footer as the head stores it (`ParquetMetaDataWriter`: page indexes, metadata, length, magic).
pub fn footer_bytes(metadata: &ParquetMetaData) -> WriteResult<Vec<u8>> {
    let mut buf = vec![];
    ParquetMetaDataWriter::new(&mut buf, metadata).finish()?;
    Ok(buf)
}
