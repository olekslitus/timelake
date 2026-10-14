//! Appending data, with inline auto-maintenance: the writer keeps the table healthy as it goes
//! (SPEC §10), so no separate compaction job is needed.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use arrow::array::RecordBatch;
use futures::{StreamExt, TryStreamExt};
use iceberg::spec::DataFile;

use crate::commit::{Change, CommitInfo, commit};
use crate::error::Result;
use crate::lvi::latest_per_series;
use crate::maintain::{MaintainOptions, MaintainReport};
use crate::summary;
use crate::table::Table;
use crate::write::{row_groups, sort_and_split, write_partition, writer_properties};

/// How many partitions an append writes at once.
const CONCURRENT_PARTITION_WRITES: usize = 8;
/// Inline maintenance expires snapshots in batches of about this many, not after every commit.
const EXPIRE_BATCH: usize = 20;

/// Options for [`Table::append`].
#[derive(Clone, Debug, Default)]
pub struct AppendOptions {
    /// Idempotency key: appending the same batch id twice commits once.
    pub batch_id: Option<String>,
    /// Override the table's `timelake.auto-maintain`.
    pub maintain: Option<bool>,
    /// Extra snapshot summary properties.
    pub properties: HashMap<String, String>,
}

/// What [`Table::append`] did.
#[derive(Debug)]
pub struct AppendResult {
    /// Rows committed by this call: 0 if the batch id was already committed (`commit.duplicate`).
    pub rows: usize,
    /// Data files committed by this call.
    pub files: usize,
    /// Bytes of data files committed by this call.
    pub bytes: u64,
    /// The commit itself.
    pub commit: CommitInfo,
    /// Inline maintenance after the commit: `None` if it didn't run or had nothing to do. An error
    /// here means the append is committed but maintenance failed: don't retry the append (without
    /// a batch id it would write the rows twice); run [`Table::maintain`] later instead.
    pub maintenance: Option<Result<MaintainReport>>,
}

impl AppendResult {
    fn nothing(commit: CommitInfo) -> Self {
        Self { rows: 0, files: 0, bytes: 0, commit, maintenance: None }
    }
}

impl Table {
    /// Appends Arrow data as one commit. Rows are aligned to the table schema, sorted by
    /// `(series_key…, time)`, and written to one file per time partition. Returns the new table
    /// version.
    pub async fn append(&self, batches: &[RecordBatch], opts: AppendOptions) -> Result<(Table, AppendResult)> {
        let partitions = sort_and_split(self, batches)?;
        let rows = partitions.iter().map(|(_, b)| b.num_rows()).sum();
        let touched: HashSet<Option<i32>> = partitions.iter().map(|(p, _)| *p).collect();
        let latest = latest_per_series(
            &self.schema(),
            self.contract(),
            &partitions.iter().map(|(_, b)| b.clone()).collect::<Vec<_>>(),
        )?;
        let files = self.write_partitions(partitions).await?;
        if files.is_empty() {
            let commit = CommitInfo {
                snapshot_id: 0,
                version: self.version(),
                attempts: 0,
                duration: Duration::ZERO,
                duplicate: false,
            };
            return Ok((self.clone(), AppendResult::nothing(commit)));
        }
        let (n_files, bytes) = (files.len(), files.iter().map(DataFile::file_size_in_bytes).sum());
        let paths: Vec<String> = files.iter().map(|f| f.file_path().to_string()).collect();

        let mut props = opts.properties.clone();
        if let Some(id) = &opts.batch_id {
            props.insert(summary::BATCH_ID.into(), id.clone());
        }
        let committed = commit(self, Change::Append { files, latest }, props).await;
        if !matches!(&committed, Ok((_, info)) if !info.duplicate) {
            // Nothing references the data files: a failed cleanup only wastes space, and the
            // commit's own outcome is what the caller needs to see.
            let _ = self.lake().storage().delete_many(paths).await;
        }
        let (table, info) = committed?;
        if info.duplicate {
            return Ok((table, AppendResult::nothing(info)));
        }

        let mut result = AppendResult { rows, files: n_files, bytes, commit: info, maintenance: None };
        if !opts.maintain.unwrap_or(table.contract().auto_maintain) {
            return Ok((table, result));
        }
        match table.maintain(table.auto_maintain_options(touched)).await {
            Ok((maintained, report)) => {
                result.maintenance = (!report.is_noop()).then_some(Ok(report));
                Ok((maintained, result))
            }
            Err(e) => {
                result.maintenance = Some(Err(e));
                Ok((table, result))
            }
        }
    }

    /// Writes each partition's rows to Parquet, a few partitions at a time.
    async fn write_partitions(&self, partitions: Vec<(Option<i32>, RecordBatch)>) -> Result<Vec<DataFile>> {
        let props = writer_properties(self)?;
        let rows_per_group = self.contract().row_group_rows;
        // The futures are created up front (not in a stream closure) so the returned future stays
        // `Send` and callers can spawn it.
        let writes: Vec<_> = partitions
            .into_iter()
            .map(|(partition, rows)| write_partition(self, partition, row_groups(rows, rows_per_group), &props))
            .collect();
        let files: Vec<Vec<DataFile>> =
            futures::stream::iter(writes).buffered(CONCURRENT_PARTITION_WRITES).try_collect().await?;
        Ok(files.into_iter().flatten().collect())
    }

    /// Cheap checks after an append: compact size tiers of the touched partitions that crossed
    /// the threshold, apply retention, and expire snapshots in batches.
    fn auto_maintain_options(&self, touched: HashSet<Option<i32>>) -> MaintainOptions {
        let c = self.contract();
        let snapshots = self.metadata().snapshots().len();
        let oldest = self.metadata().snapshots().map(|s| s.timestamp_ms()).min().unwrap_or(i64::MAX);
        let retention_ms = i64::try_from(c.snapshot_retention.as_millis()).unwrap_or(i64::MAX);
        let cutoff = chrono::Utc::now().timestamp_millis().saturating_sub(retention_ms);
        MaintainOptions {
            compact: true,
            retention: c.retention.is_some(),
            expire: snapshots >= c.max_snapshots + EXPIRE_BATCH
                || (snapshots >= c.min_snapshots + EXPIRE_BATCH && oldest < cutoff),
            min_small_files: c.compact_min_files,
            partitions: Some(touched),
            tiered: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{Op, T0, batch, faulty_lake, opts, schema};

    /// A failure in inline maintenance after the append committed is reported, not returned as an
    /// error: a caller retrying the "failed" append would write the rows twice.
    #[tokio::test]
    async fn failed_maintenance_keeps_the_committed_append() {
        let (lake, store) = faulty_lake();
        let mut o = opts();
        o.properties.insert(crate::property::COMPACT_MIN_FILES.into(), "2".into());
        let t = lake.create_table("iot.r", &schema(), o).await.unwrap();
        let (t, r) = t.append(&[batch(&[(T0, 1, 1.0)])], AppendOptions::default()).await.unwrap();
        assert!(r.maintenance.is_none());

        // The second small file triggers compaction, which can't read the data files.
        store.fail(Op::Get, "/data/");
        let (t2, r) = t.append(&[batch(&[(T0 + 1, 1, 2.0)])], AppendOptions::default()).await.unwrap();
        assert!(matches!(r.maintenance, Some(Err(_))), "{:?}", r.maintenance);
        assert_eq!((t2.version(), r.rows), (t.version() + 1, 1));
        store.heal();
        assert_eq!(lake.table("iot.r").await.unwrap().files().await.unwrap().len(), 2);

        // Maintenance can simply run again later.
        let (t3, report) = t2.maintain(MaintainOptions::default()).await.unwrap();
        assert_eq!(report.files_rewritten, 2);
        assert_eq!(t3.files().await.unwrap().len(), 1);
    }

    /// A batch id that is already committed appends nothing, and the result says so.
    #[tokio::test]
    async fn duplicate_batch_reports_nothing_appended() {
        let (lake, store) = faulty_lake();
        let t = lake.create_table("iot.r", &schema(), opts()).await.unwrap();
        let opts = AppendOptions { batch_id: Some("b1".into()), ..Default::default() };
        let rows = batch(&[(T0, 1, 1.0), (T0, 2, 2.0)]);
        let (t1, first) = t.append(std::slice::from_ref(&rows), opts.clone()).await.unwrap();
        assert_eq!((first.rows, first.files, first.commit.duplicate), (2, 1, false));
        let objects = store.paths().await;

        let (t2, second) = t1.append(&[rows], opts).await.unwrap();
        assert!(second.commit.duplicate);
        assert_eq!((second.rows, second.files, second.bytes), (0, 0, 0));
        assert!(second.maintenance.is_none());
        assert_eq!(t2.version(), t1.version());
        // The data files written before the duplicate was detected are gone again.
        assert_eq!(store.paths().await, objects);
    }

    #[tokio::test]
    async fn empty_append_commits_nothing() {
        let (lake, _store) = faulty_lake();
        let t = lake.create_table("iot.r", &schema(), opts()).await.unwrap();
        let (t2, r) = t.append(&[batch(&[])], AppendOptions::default()).await.unwrap();
        assert_eq!((t2.version(), r.rows, r.files, r.commit.attempts), (t.version(), 0, 0, 0));
    }

    #[tokio::test]
    async fn out_of_range_time_is_an_error() {
        let (lake, _store) = faulty_lake();
        let t = lake.create_table("iot.r", &schema(), opts()).await.unwrap();
        assert!(t.append(&[batch(&[(i64::MAX, 1, 1.0)])], AppendOptions::default()).await.is_err());
    }

    /// The append future can be spawned onto a multi-threaded runtime.
    #[tokio::test]
    async fn append_future_is_send() {
        fn assert_send<T: Send>(_: &T) {}
        let (lake, _store) = faulty_lake();
        let table = lake.create_table("iot.r", &schema(), opts()).await.unwrap();
        assert_send(&table.append(&[], AppendOptions::default()));
    }
}
