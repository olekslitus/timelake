//! Table operations: append (with inline auto-maintenance) and maintenance (compaction with
//! dedup, retention, snapshot expiry). This replaces the "custom Glue jobs" (SPEC §10): the writer
//! keeps the table healthy as it goes, or `maintain` runs as one stateless command.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::{Duration, Instant};

use arrow::array::{RecordBatch, UInt32Array};
use arrow::compute::{SortColumn, SortOptions, concat_batches, lexsort_to_indices, take_record_batch};
use futures::TryStreamExt;
use iceberg::spec::{DataFile, TableMetadataBuilder};
use parquet::arrow::ParquetRecordBatchStreamBuilder;
use parquet::arrow::async_reader::ParquetObjectReader;

use crate::commit::{Change, CommitInfo, commit, publish};
use crate::error::Result;
use crate::lake::{LiveEntry, S_BATCH_ID, S_LVI, Table};
use crate::lvi::latest_per_series;
use crate::write::{align_batch, chunks, file_partition, sort_and_split, write_partition, writer_properties};

#[derive(Clone, Debug, Default)]
pub struct AppendOptions {
    /// Idempotency key: appending the same batch id twice commits once.
    pub batch_id: Option<String>,
    /// Override the table's `timelake.auto-maintain`.
    pub maintain: Option<bool>,
    /// Extra snapshot summary properties.
    pub properties: HashMap<String, String>,
}

#[derive(Clone, Debug)]
pub struct AppendResult {
    pub rows: usize,
    pub files: usize,
    pub bytes: u64,
    pub commit: CommitInfo,
    pub maintenance: Option<MaintainReport>,
}

#[derive(Clone, Debug)]
pub struct MaintainOptions {
    pub compact: bool,
    pub retention: bool,
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

#[derive(Clone, Debug, Default)]
pub struct MaintainReport {
    pub partitions_compacted: usize,
    pub files_rewritten: usize,
    pub files_written: usize,
    pub rows_rewritten: u64,
    pub duplicates_removed: u64,
    pub partitions_dropped: usize,
    pub files_dropped: usize,
    pub snapshots_expired: usize,
    pub objects_deleted: usize,
    pub duration: Duration,
}

impl MaintainReport {
    pub fn is_noop(&self) -> bool {
        self.files_rewritten == 0 && self.files_dropped == 0 && self.snapshots_expired == 0 && self.objects_deleted == 0
    }
}

impl Table {
    /// Appends Arrow data as one commit. Rows are aligned to the table schema, sorted by
    /// `(series_key…, time)`, and written to one file per time partition. Returns the new table
    /// version.
    pub async fn append(&self, batches: &[RecordBatch], opts: AppendOptions) -> Result<(Table, AppendResult)> {
        let parts = sort_and_split(self, batches)?;
        let rows = parts.iter().map(|(_, b)| b.num_rows()).sum();
        let props = writer_properties(self)?;
        let rg = self.contract.row_group_rows;
        // Write partitions concurrently, 8 at a time. (Plain loops instead of stream combinators keep
        // the future `Send`, so callers can spawn it.)
        let mut files: Vec<DataFile> = vec![];
        for group in parts.chunks(8) {
            let mut futs = Vec::with_capacity(group.len());
            for (p, b) in group.iter().cloned() {
                futs.push(write_partition(self, p, chunks(b, rg), &props));
            }
            files.extend(futures::future::try_join_all(futs).await?.into_iter().flatten());
        }
        let touched: HashSet<Option<i32>> = parts.iter().map(|(p, _)| *p).collect();
        let sorted: Vec<RecordBatch> = parts.into_iter().map(|(_, b)| b).collect();
        let latest = latest_per_series(&self.schema(), &self.contract, &sorted)?;
        let n_files = files.len();
        let bytes = files.iter().map(|f| f.file_size_in_bytes()).sum();

        let mut summary = opts.properties.clone();
        if let Some(id) = &opts.batch_id {
            summary.insert(S_BATCH_ID.into(), id.clone());
        }
        let (table, info) = if files.is_empty() {
            (
                self.clone(),
                CommitInfo {
                    snapshot_id: 0,
                    version: self.version,
                    attempts: 0,
                    duration: Duration::ZERO,
                    duplicate: false,
                },
            )
        } else {
            let res = commit(self, Change::Append { files: files.clone(), latest }, summary).await;
            if matches!(&res, Ok((_, i)) if i.duplicate) || res.is_err() {
                let uris = files.iter().map(|f| f.file_path().to_string()).collect();
                let _ = self.lake.storage().delete_many(uris).await;
            }
            res?
        };

        let mut result = AppendResult { rows, files: n_files, bytes, commit: info, maintenance: None };
        if opts.maintain.unwrap_or(table.contract.auto_maintain) && !result.commit.duplicate && n_files > 0 {
            let (t, report) = table.auto_maintain(touched).await?;
            result.maintenance = (!report.is_noop()).then_some(report);
            return Ok((t, result));
        }
        Ok((table, result))
    }

    /// Cheap checks after an append; does work only when thresholds are crossed.
    async fn auto_maintain(&self, touched: HashSet<Option<i32>>) -> Result<(Table, MaintainReport)> {
        let c = &self.contract;
        let opts = MaintainOptions {
            compact: true,
            retention: c.retention.is_some(),
            // Expire in batches of ~20 snapshots: past max_snapshots, or once the oldest is past the
            // retention period.
            expire: {
                let n = self.metadata.snapshots().len();
                let oldest = self.metadata.snapshots().map(|s| s.timestamp_ms()).min().unwrap_or(i64::MAX);
                let cutoff = chrono::Utc::now().timestamp_millis() - c.snapshot_retention.as_millis() as i64;
                n >= c.max_snapshots + 20 || (n >= c.min_snapshots + 20 && oldest < cutoff)
            },
            min_small_files: c.compact_min_files,
            partitions: Some(touched),
            tiered: true,
        };
        self.maintain(opts).await
    }

    /// Runs maintenance: retention, then compaction, then snapshot expiry and file cleanup.
    pub async fn maintain(&self, opts: MaintainOptions) -> Result<(Table, MaintainReport)> {
        let t0 = Instant::now();
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
        report.duration = t0.elapsed();
        Ok((table, report))
    }
}

/// Drops whole time partitions that are entirely older than the retention period.
async fn retention(table: &Table, report: &mut MaintainReport) -> Result<Table> {
    let (Some(ret), Some(chunk)) = (table.contract.retention, table.contract.chunk) else { return Ok(table.clone()) };
    let cutoff = chrono::Utc::now().timestamp_micros() - ret.as_micros() as i64;
    let removed: Vec<LiveEntry> = table
        .files()
        .await?
        .into_iter()
        .filter(|e| file_partition(&e.data_file).is_some_and(|p| chunk.end_micros(p) <= cutoff))
        .collect();
    if removed.is_empty() {
        return Ok(table.clone());
    }
    report.partitions_dropped += removed.iter().map(|e| file_partition(&e.data_file)).collect::<HashSet<_>>().len();
    report.files_dropped += removed.len();
    let (t, _) = commit(table, Change::Delete { removed, lvi_cutoff: Some(cutoff) }, HashMap::new()).await?;
    Ok(t)
}

/// Rewrites partitions with many small (or unsorted) files into sorted files of the target size,
/// removing duplicate `(series_key, time)` rows (latest write wins) when dedup is on.
async fn compact(table: &Table, opts: &MaintainOptions, report: &mut MaintainReport) -> Result<Table> {
    let c = &table.contract;
    let small = c.target_file_size * 3 / 4;
    let sort_id = table.metadata.default_sort_order_id() as i32;
    let sorted_table = !c.sort_columns().is_empty();

    let mut by_part: BTreeMap<Option<i32>, Vec<LiveEntry>> = BTreeMap::new();
    for e in table.files().await? {
        let p = file_partition(&e.data_file);
        if opts.partitions.as_ref().is_none_or(|ps| ps.contains(&p)) {
            by_part.entry(p).or_default().push(e);
        }
    }
    let mut plan: Vec<(Option<i32>, Vec<LiveEntry>)> = vec![];
    for (p, files) in by_part {
        if opts.tiered {
            // Size tiers of 4× (64 KiB, 256 KiB, 1 MiB, …): merge a tier once it has enough files.
            let mut tiers: BTreeMap<u32, Vec<LiveEntry>> = BTreeMap::new();
            for e in files.into_iter().filter(|e| e.data_file.file_size_in_bytes() < small) {
                let tier = (e.data_file.file_size_in_bytes() >> 16).max(1).ilog(4);
                tiers.entry(tier).or_default().push(e);
            }
            for (_, group) in tiers {
                if group.len() >= opts.min_small_files.max(2) {
                    plan.push((p, group));
                }
            }
            continue;
        }
        let n_small = files.iter().filter(|e| e.data_file.file_size_in_bytes() < small).count();
        let unsorted = sorted_table && files.iter().any(|e| e.data_file.sort_order_id() != Some(sort_id));
        if !(n_small >= opts.min_small_files.max(2) || (unsorted && opts.min_small_files <= 2)) {
            continue;
        }
        let total: u64 = files.iter().map(|e| e.data_file.file_size_in_bytes()).sum();
        let picked = if total <= 2 * c.target_file_size || unsorted {
            files
        } else {
            files.into_iter().filter(|e| e.data_file.file_size_in_bytes() < small).collect()
        };
        if picked.len() >= 2 || (unsorted && !picked.is_empty()) {
            plan.push((p, picked));
        }
    }
    if plan.is_empty() {
        return Ok(table.clone());
    }

    let props = writer_properties(table)?;
    let mut removed = vec![];
    let mut added = vec![];
    for (p, mut files) in plan {
        // Older commits first, so "later row wins" means "latest write wins".
        files.sort_by_key(|e| (e.sequence_number, e.data_file.file_path().to_string()));
        let mut batches: Vec<RecordBatch> = vec![];
        for group in files.chunks(8) {
            let mut futs = Vec::with_capacity(group.len());
            for e in group {
                futs.push(read_file(table, &e.data_file));
            }
            batches.extend(futures::future::try_join_all(futs).await?.into_iter().flatten());
        }
        let rows_in: usize = batches.iter().map(|b| b.num_rows()).sum();
        let merged = sort_dedup(table, &batches)?;
        report.duplicates_removed += (rows_in - merged.num_rows()) as u64;
        report.rows_rewritten += rows_in as u64;
        added.extend(write_partition(table, p, chunks(merged, c.row_group_rows), &props).await?);
        report.partitions_compacted += 1;
        report.files_rewritten += files.len();
        removed.extend(files);
    }
    report.files_written += added.len();
    match commit(table, Change::Replace { removed, added: added.clone() }, HashMap::new()).await {
        Ok((t, _)) => Ok(t),
        Err(e) => {
            let _ = table.lake.storage().delete_many(added.iter().map(|f| f.file_path().to_string()).collect()).await;
            Err(e)
        }
    }
}

async fn read_file(table: &Table, df: &DataFile) -> Result<Vec<RecordBatch>> {
    let storage = table.lake.storage();
    let reader = ParquetObjectReader::new(storage.object_store(), storage.path(df.file_path())?)
        .with_file_size(df.file_size_in_bytes());
    let stream = ParquetRecordBatchStreamBuilder::new(reader).await?.with_batch_size(64 * 1024).build()?;
    let schema = table.schema();
    let batches: Vec<RecordBatch> = stream.try_collect().await?;
    batches.iter().map(|b| align_batch(b, &schema)).collect()
}

/// Sorts by `(series…, time)` with input order as the tiebreak, then keeps the last row of each
/// `(series…, time)` group if dedup is on.
fn sort_dedup(table: &Table, batches: &[RecordBatch]) -> Result<RecordBatch> {
    let schema = table.schema();
    let all = concat_batches(&schema, batches)?;
    let cols = table.contract.sort_columns();
    if cols.is_empty() || all.num_rows() == 0 {
        return Ok(all);
    }
    let mut keys = cols
        .iter()
        .map(|c| {
            Ok(SortColumn {
                values: all.column(schema.index_of(c)?).clone(),
                options: Some(SortOptions { descending: false, nulls_first: true }),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    keys.push(SortColumn {
        values: std::sync::Arc::new(UInt32Array::from_iter_values(0..all.num_rows() as u32)),
        options: None,
    });
    let sorted = take_record_batch(&all, &lexsort_to_indices(&keys, None)?)?;
    if !table.contract.dedup {
        return Ok(sorted);
    }
    let key_cols = cols.iter().map(|c| Ok(sorted.column(schema.index_of(c)?).clone())).collect::<Result<Vec<_>>>()?;
    let ranges = arrow::compute::partition(&key_cols)?.ranges();
    if ranges.len() == sorted.num_rows() {
        return Ok(sorted);
    }
    let last = UInt32Array::from_iter_values(ranges.iter().map(|r| (r.end - 1) as u32));
    Ok(take_record_batch(&sorted, &last)?)
}

/// Expires old snapshots and deletes the files only they referenced.
async fn expire(table: &Table, report: &mut MaintainReport) -> Result<Table> {
    let mut table = table.clone();
    loop {
        let c = &table.contract;
        let meta = &table.metadata;
        let current = meta.current_snapshot_id();
        let mut snaps: Vec<_> = meta.snapshots().cloned().collect();
        snaps.sort_by_key(|s| std::cmp::Reverse(s.timestamp_ms()));
        let cutoff = chrono::Utc::now().timestamp_millis() - c.snapshot_retention.as_millis() as i64;
        let expired: Vec<i64> = snaps
            .iter()
            .enumerate()
            .filter(|(i, s)| {
                Some(s.snapshot_id()) != current
                    && *i >= c.min_snapshots
                    && (s.timestamp_ms() < cutoff || *i >= c.max_snapshots)
            })
            .map(|(_, s)| s.snapshot_id())
            .collect();
        if expired.is_empty() {
            break;
        }
        let new_meta = TableMetadataBuilder::new_from_metadata(
            (**meta).clone(),
            Some(crate::lake::metadata_uri(&table.location, table.version)),
        )
        .remove_snapshots(&expired)
        .build()?
        .metadata;
        let Some(t) = publish(&table, new_meta).await? else {
            table = table.refresh().await?;
            continue;
        };
        report.snapshots_expired += expired.len();
        let old = table;
        table = t;

        // Files reachable from the expired snapshots but not from the remaining ones.
        let kept = reachable(&table, &table.metadata.snapshots().cloned().collect::<Vec<_>>()).await?;
        let gone =
            reachable(&old, &snaps.iter().filter(|s| expired.contains(&s.snapshot_id())).cloned().collect::<Vec<_>>())
                .await?;
        let doomed: Vec<String> = gone.difference(&kept).cloned().collect();
        report.objects_deleted += table.lake.storage().delete_many(doomed).await?;
        report.objects_deleted += prune_metadata_files(&table).await?;
        break;
    }
    Ok(table)
}

/// Every object (manifest lists, manifests, data files, last-value indexes) a set of snapshots uses.
async fn reachable(table: &Table, snapshots: &[iceberg::spec::SnapshotRef]) -> Result<HashSet<String>> {
    let mut out = HashSet::new();
    let mut seen_manifests = HashSet::new();
    for s in snapshots {
        out.insert(s.manifest_list().to_string());
        if let Some(l) = s.summary().additional_properties.get(S_LVI) {
            out.insert(l.clone());
        }
        let list = match table.lake.manifest_list(s.manifest_list(), table.metadata.format_version()).await {
            Ok(l) => l,
            Err(crate::Error::ObjectStore(object_store::Error::NotFound { .. })) => continue,
            Err(e) => return Err(e),
        };
        for mf in list.iter() {
            out.insert(mf.manifest_path.clone());
            if !seen_manifests.insert(mf.manifest_path.clone()) {
                continue;
            }
            // Entries marked deleted only record a removal; the file itself is unreferenced.
            for e in
                table.lake.manifest(mf).await?.iter().filter(|e| e.status != iceberg::spec::ManifestStatus::Deleted)
            {
                out.insert(e.data_file.file_path().to_string());
            }
        }
    }
    Ok(out)
}

/// Keeps the newest metadata files (those in the metadata log plus the current one).
async fn prune_metadata_files(table: &Table) -> Result<usize> {
    let keep_from = table.version.saturating_sub(table.metadata.metadata_log().len() as u64 + 1);
    let mut doomed = vec![];
    for (uri, _, _) in table.lake.storage().list(&format!("{}/metadata", table.location)).await? {
        let name = uri.rsplit('/').next().unwrap_or_default();
        if let Some(v) =
            name.strip_prefix('v').and_then(|s| s.strip_suffix(".metadata.json")).and_then(|s| s.parse::<u64>().ok())
            && v < keep_from
        {
            doomed.push(uri);
        }
    }
    table.lake.storage().delete_many(doomed).await
}
