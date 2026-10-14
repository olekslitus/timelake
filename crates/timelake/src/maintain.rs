//! Maintenance: retention, compaction with dedup, and snapshot expiry with file cleanup. This
//! replaces the "custom Glue jobs" (SPEC §10): appends run it inline as thresholds are crossed,
//! or [`Table::maintain`] runs it as one stateless command.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::{Duration, Instant};

use arrow::array::RecordBatch;
use arrow::compute::concat_batches;
use futures::{StreamExt, TryStreamExt};
use iceberg::spec::{DataFile, ManifestStatus, SnapshotRef, TableMetadataBuilder};
use parquet::arrow::ParquetRecordBatchStreamBuilder;
use parquet::arrow::async_reader::ParquetObjectReader;
use parquet::file::properties::WriterProperties;

use crate::commit::{Change, commit, publish};
use crate::error::{Error, Result};
use crate::lake::metadata_uri;
use crate::schema::align_batch;
use crate::sort::{last_per_group, stable_sort};
use crate::storage::Uploads;
use crate::summary;
use crate::table::{LiveEntry, Table};
use crate::write::{file_partition, row_groups, write_partition, writer_properties};

/// Files smaller than this fraction of the target size count as small (worth compacting).
const SMALL_FILE_NUMERATOR: u64 = 3;
const SMALL_FILE_DENOMINATOR: u64 = 4;
/// Tiered compaction groups small files by size: tier `n` holds files of
/// `TIER_BASE × TIER_GROWTH^n` bytes and up (64 KiB, 256 KiB, 1 MiB, …).
const TIER_BASE_SHIFT: u32 = 16;
const TIER_GROWTH: u64 = 4;
/// A partition whose files total at most this many target sizes is rewritten whole.
const REWRITE_WHOLE_PARTITION_TARGETS: u64 = 2;
/// How many data files compaction reads at once.
const CONCURRENT_FILE_READS: usize = 8;
/// Rows per batch when reading a data file back for compaction.
const READ_BATCH_ROWS: usize = 64 * 1024;
/// How many manifest lists or manifests expiry reads at once.
const CONCURRENT_METADATA_READS: usize = 16;

/// Options for [`Table::maintain`]. The default does everything, rewriting each partition into
/// sorted files of the target size.
#[derive(Clone, Debug)]
pub struct MaintainOptions {
    /// Merge small or unsorted files.
    pub compact: bool,
    /// Drop partitions older than the table's retention.
    pub retention: bool,
    /// Expire old snapshots and delete the files only they used.
    pub expire: bool,
    /// Compact a partition once it has this many small files (default: 2, i.e. whenever useful).
    pub min_small_files: usize,
    /// Only consider these partitions (None = all).
    pub partitions: Option<HashSet<Option<i32>>>,
    /// Size-tiered mode (inline auto-maintenance): merge groups of similarly sized small files
    /// instead of rewriting whole partitions, so write amplification stays logarithmic while
    /// micro-batches stream in. `maintain` without it produces one sorted file per partition.
    pub tiered: bool,
}

impl Default for MaintainOptions {
    fn default() -> Self {
        Self { compact: true, retention: true, expire: true, min_small_files: 2, partitions: None, tiered: false }
    }
}

/// What [`Table::maintain`] did.
#[derive(Clone, Debug, Default)]
pub struct MaintainReport {
    /// Partitions compacted.
    pub partitions_compacted: usize,
    /// Data files replaced by compaction.
    pub files_rewritten: usize,
    /// Data files compaction wrote.
    pub files_written: usize,
    /// Rows read by compaction.
    pub rows_rewritten: u64,
    /// Duplicate `(series, time)` rows compaction removed.
    pub duplicates_removed: u64,
    /// Partitions dropped by retention.
    pub partitions_dropped: usize,
    /// Data files dropped by retention.
    pub files_dropped: usize,
    /// Snapshots expired.
    pub snapshots_expired: usize,
    /// Objects deleted after expiry (data files, manifests, metadata files).
    pub objects_deleted: usize,
    /// Time taken.
    pub duration: Duration,
}

impl MaintainReport {
    /// Whether nothing changed.
    pub fn is_noop(&self) -> bool {
        self.files_rewritten == 0 && self.files_dropped == 0 && self.snapshots_expired == 0 && self.objects_deleted == 0
    }
}

impl Table {
    /// Runs maintenance: retention, then compaction, then snapshot expiry and file cleanup.
    /// Returns the new table version.
    pub async fn maintain(&self, opts: MaintainOptions) -> Result<(Table, MaintainReport)> {
        let started = Instant::now();
        let mut report = MaintainReport::default();
        let mut table = self.clone();
        if opts.retention {
            table = retention(&table, &mut report).await?;
        }
        if opts.compact {
            table = compact(&table, &opts, &mut report).await?;
        }
        if opts.expire {
            table = expire(&table, &mut report).await?;
        }
        report.duration = started.elapsed();
        Ok((table, report))
    }
}

fn now_micros() -> i64 {
    chrono::Utc::now().timestamp_micros()
}

fn micros(d: Duration) -> i64 {
    i64::try_from(d.as_micros()).unwrap_or(i64::MAX)
}

/// Drops whole time partitions that are entirely older than the retention period.
async fn retention(table: &Table, report: &mut MaintainReport) -> Result<Table> {
    let (Some(retention), Some(chunk)) = (table.contract().retention, table.contract().chunk) else {
        return Ok(table.clone());
    };
    let cutoff = now_micros().saturating_sub(micros(retention));
    let expired = |p: i32| chunk.end_micros(p).is_ok_and(|end| end <= cutoff);
    let removed: Vec<LiveEntry> =
        table.files().await?.into_iter().filter(|e| file_partition(&e.data_file).is_some_and(expired)).collect();
    if removed.is_empty() {
        return Ok(table.clone());
    }
    report.partitions_dropped += removed.iter().map(|e| file_partition(&e.data_file)).collect::<HashSet<_>>().len();
    report.files_dropped += removed.len();
    let change = Change::Delete { removed, lvi_cutoff: Some(cutoff) };
    let (table, _) = commit(table, change, HashMap::new(), Uploads::default()).await?;
    Ok(table)
}

/// Rewrites partitions with many small (or unsorted) files into sorted files of the target size,
/// removing duplicate `(series_key, time)` rows (latest write wins) when dedup is on.
async fn compact(table: &Table, opts: &MaintainOptions, report: &mut MaintainReport) -> Result<Table> {
    let plan = compaction_plan(table, opts).await?;
    if plan.is_empty() {
        return Ok(table.clone());
    }
    let props = writer_properties(table)?;
    let uploads = Uploads::default();
    let (mut removed, mut added) = (vec![], vec![]);
    let mut outcome = Ok(());
    for (partition, mut files) in plan {
        // Older commits first, so "later row wins" means "latest write wins".
        files.sort_by(|a, b| {
            (a.sequence_number, a.data_file.file_path()).cmp(&(b.sequence_number, b.data_file.file_path()))
        });
        match rewrite_partition(table, partition, &files, &props, &uploads, report).await {
            Ok(written) => {
                added.extend(written);
                removed.extend(files);
            }
            Err(e) => {
                outcome = Err(e);
                break;
            }
        }
    }
    report.files_written += added.len();
    let paths: Vec<String> = added.iter().map(|f| f.file_path().to_string()).collect();
    let committed = match outcome {
        Ok(()) => commit(table, Change::Replace { removed, added }, HashMap::new(), uploads).await,
        Err(e) => {
            uploads.abort().await;
            Err(e)
        }
    };
    if committed.is_err() {
        // Unreferenced: a failed cleanup only wastes space, and the original error matters more.
        let _ = table.lake().storage().delete_many(paths).await;
    }
    Ok(committed?.0)
}

/// Merges the rows of `files` (oldest commit first) into sorted, deduplicated new files.
async fn rewrite_partition(
    table: &Table,
    partition: Option<i32>,
    files: &[LiveEntry],
    props: &WriterProperties,
    uploads: &Uploads,
    report: &mut MaintainReport,
) -> Result<Vec<DataFile>> {
    let batches = read_files(table, files).await?;
    let rows_in: usize = batches.iter().map(RecordBatch::num_rows).sum();
    let merged = sort_dedup(table, &batches)?;
    report.duplicates_removed += (rows_in - merged.num_rows()) as u64;
    report.rows_rewritten += rows_in as u64;
    report.partitions_compacted += 1;
    report.files_rewritten += files.len();
    write_partition(table, partition, row_groups(merged, table.contract().row_group_rows), props, uploads).await
}

/// Which files of which partitions to rewrite.
pub(crate) async fn compaction_plan(
    table: &Table,
    opts: &MaintainOptions,
) -> Result<Vec<(Option<i32>, Vec<LiveEntry>)>> {
    let c = table.contract();
    let small = c.target_file_size / SMALL_FILE_DENOMINATOR * SMALL_FILE_NUMERATOR;
    let is_small = |e: &LiveEntry| e.data_file.file_size_in_bytes() < small;
    let sort_order_id = i32::try_from(table.metadata().default_sort_order_id()).ok();
    let sorted_table = !c.sort_columns().is_empty();
    let min_files = opts.min_small_files.max(2);

    let mut by_partition: BTreeMap<Option<i32>, Vec<LiveEntry>> = BTreeMap::new();
    for e in table.files().await? {
        let p = file_partition(&e.data_file);
        if opts.partitions.as_ref().is_none_or(|ps| ps.contains(&p)) {
            by_partition.entry(p).or_default().push(e);
        }
    }
    let mut plan = vec![];
    for (partition, files) in by_partition {
        if opts.tiered {
            let mut tiers: BTreeMap<u32, Vec<LiveEntry>> = BTreeMap::new();
            for e in files.into_iter().filter(is_small) {
                let tier = (e.data_file.file_size_in_bytes() >> TIER_BASE_SHIFT).max(1).ilog(TIER_GROWTH);
                tiers.entry(tier).or_default().push(e);
            }
            plan.extend(tiers.into_values().filter(|group| group.len() >= min_files).map(|group| (partition, group)));
            continue;
        }
        let n_small = files.iter().filter(|e| is_small(e)).count();
        let unsorted = sorted_table && files.iter().any(|e| e.data_file.sort_order_id() != sort_order_id);
        if n_small < min_files && !(unsorted && opts.min_small_files <= 2) {
            continue;
        }
        let total: u64 = files.iter().map(|e| e.data_file.file_size_in_bytes()).sum();
        let picked: Vec<LiveEntry> = if total <= REWRITE_WHOLE_PARTITION_TARGETS * c.target_file_size || unsorted {
            files
        } else {
            files.into_iter().filter(is_small).collect()
        };
        if picked.len() >= 2 || (unsorted && !picked.is_empty()) {
            plan.push((partition, picked));
        }
    }
    Ok(plan)
}

/// Reads data files back, aligned to the table schema, in the given order.
async fn read_files(table: &Table, files: &[LiveEntry]) -> Result<Vec<RecordBatch>> {
    let reads: Vec<_> = files.iter().map(|e| read_file(table, &e.data_file)).collect();
    let batches: Vec<Vec<RecordBatch>> =
        futures::stream::iter(reads).buffered(CONCURRENT_FILE_READS).try_collect().await?;
    Ok(batches.into_iter().flatten().collect())
}

async fn read_file(table: &Table, df: &DataFile) -> Result<Vec<RecordBatch>> {
    let storage = table.lake().storage();
    let reader = ParquetObjectReader::new(storage.object_store(), storage.path(df.file_path())?)
        .with_file_size(df.file_size_in_bytes());
    let stream = ParquetRecordBatchStreamBuilder::new(reader).await?.with_batch_size(READ_BATCH_ROWS).build()?;
    let schema = table.schema();
    let batches: Vec<RecordBatch> = stream.try_collect().await?;
    batches.iter().map(|b| align_batch(b, &schema)).collect()
}

/// Sorts by `(series…, time)` with input order as the tiebreak, then keeps the last row of each
/// `(series…, time)` group if dedup is on.
fn sort_dedup(table: &Table, batches: &[RecordBatch]) -> Result<RecordBatch> {
    let columns = table.contract().sort_columns();
    let sorted = stable_sort(&concat_batches(&table.schema(), batches)?, &columns)?;
    if table.contract().dedup && !columns.is_empty() { last_per_group(&sorted, &columns) } else { Ok(sorted) }
}

/// Expires old snapshots and deletes the files only they referenced.
async fn expire(table: &Table, report: &mut MaintainReport) -> Result<Table> {
    let mut table = table.clone();
    loop {
        let mut snapshots: Vec<SnapshotRef> = table.metadata().snapshots().cloned().collect();
        snapshots.sort_by_key(|s| std::cmp::Reverse(s.timestamp_ms()));
        let expired = expired_snapshots(&table, &snapshots);
        if expired.is_empty() {
            return Ok(table);
        }
        let ids: Vec<i64> = expired.iter().map(|s| s.snapshot_id()).collect();
        let previous = Some(metadata_uri(table.location(), table.version()));
        let metadata = TableMetadataBuilder::new_from_metadata(table.metadata().clone(), previous)
            .remove_snapshots(&ids)
            .build()?
            .metadata;
        // Expiry keeps the current snapshot, so its files stay the same.
        let Some(expired_table) = publish(&table, metadata, table.known_files().cloned()).await? else {
            // Lost the race to another writer: recompute against its version.
            table = table.refresh().await?;
            continue;
        };
        report.snapshots_expired += expired.len();

        // Files reachable from the expired snapshots but not from the remaining ones.
        let remaining: Vec<SnapshotRef> = expired_table.metadata().snapshots().cloned().collect();
        let (kept, gone) = futures::try_join!(reachable(&expired_table, &remaining), reachable(&table, &expired))?;
        let storage = table.lake().storage();
        report.objects_deleted += storage.delete_many(gone.difference(&kept).cloned().collect()).await?;
        report.objects_deleted += prune_metadata_files(&expired_table).await?;
        return Ok(expired_table);
    }
}

/// Snapshots (newest first) to expire: past the newest `min_snapshots`, and either older than
/// the snapshot retention or beyond `max_snapshots`. The current snapshot always stays.
fn expired_snapshots(table: &Table, newest_first: &[SnapshotRef]) -> Vec<SnapshotRef> {
    let c = table.contract();
    let now_ms = chrono::Utc::now().timestamp_millis();
    if c.keep_snapshots_until.is_some_and(|until| now_ms < until) {
        return vec![];
    }
    let current = table.metadata().current_snapshot_id();
    let retention_ms = i64::try_from(c.snapshot_retention.as_millis()).unwrap_or(i64::MAX);
    let cutoff = now_ms.saturating_sub(retention_ms);
    newest_first
        .iter()
        .enumerate()
        .filter(|(i, s)| {
            Some(s.snapshot_id()) != current
                && *i >= c.min_snapshots
                && (s.timestamp_ms() < cutoff || *i >= c.max_snapshots)
        })
        .map(|(_, s)| s.clone())
        .collect()
}

/// Every object (manifest lists, manifests, data files, last-value indexes) a set of snapshots uses.
async fn reachable(table: &Table, snapshots: &[SnapshotRef]) -> Result<HashSet<String>> {
    let lake = table.lake();
    let mut out = HashSet::new();
    for s in snapshots {
        out.insert(s.manifest_list().to_string());
        if let Some(index) = s.summary().additional_properties.get(summary::LAST_VALUE_INDEX) {
            out.insert(index.clone());
        }
    }
    let version = table.metadata().format_version();
    let lists = snapshots.iter().map(|s| async move {
        match lake.manifest_list(s.manifest_list(), version).await {
            Ok(list) => Ok(Some(list)),
            // Already deleted by an earlier, interrupted expiry: nothing more to find.
            Err(Error::ObjectStore(object_store::Error::NotFound { .. })) => Ok(None),
            Err(e) => Err(e),
        }
    });
    let lists: Vec<_> = futures::stream::iter(lists.collect::<Vec<_>>())
        .buffered(CONCURRENT_METADATA_READS)
        .try_collect::<Vec<_>>()
        .await?;
    let mut manifests = HashMap::new();
    for manifest in lists.iter().flatten().flat_map(|l| l.iter()) {
        out.insert(manifest.manifest_path.clone());
        manifests.entry(manifest.manifest_path.as_str()).or_insert(manifest);
    }
    let loads: Vec<_> = manifests.into_values().map(|m| lake.manifest(m)).collect();
    let entries: Vec<_> = futures::stream::iter(loads).buffered(CONCURRENT_METADATA_READS).try_collect().await?;
    // Entries marked deleted only record a removal; the file itself is unreferenced.
    for e in entries.iter().flat_map(|es| es.iter()).filter(|e| e.status != ManifestStatus::Deleted) {
        out.insert(e.data_file.file_path().to_string());
    }
    Ok(out)
}

/// Keeps the newest metadata files (those in the metadata log plus the current one).
async fn prune_metadata_files(table: &Table) -> Result<usize> {
    let keep_from = table.version().saturating_sub(table.metadata().metadata_log().len() as u64 + 1);
    let storage = table.lake().storage();
    let doomed = storage
        .list(&format!("{}/metadata", table.location()))
        .await?
        .into_iter()
        .map(|o| o.uri)
        .filter(|uri| {
            let name = uri.rsplit('/').next().unwrap_or_default();
            name.strip_prefix('v')
                .and_then(|s| s.strip_suffix(".metadata.json"))
                .and_then(|s| s.parse::<u64>().ok())
                .is_some_and(|v| v < keep_from)
        })
        .collect();
    storage.delete_many(doomed).await
}
