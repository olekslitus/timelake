//! Timelake's own Iceberg commit layer (SPEC D13), built on iceberg-rust's public spec types.
//!
//! iceberg-rust 0.10 only exposes fast-append transactions; compaction and retention need
//! "replace" and "delete" snapshots, and frequent appends need manifest merging so that planning a
//! scan doesn't fetch one manifest per commit. This module writes manifests, manifest lists,
//! snapshots and table metadata directly, then commits through the object-store catalog with
//! optimistic retries.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use arrow::array::RecordBatch;
use bytes::Bytes;
use iceberg::spec::{
    DataFile, ManifestFile, ManifestStatus, ManifestWriterBuilder, ManifestListWriter, Operation, Snapshot,
    Summary, TableMetadataBuilder, UNASSIGNED_SEQUENCE_NUMBER,
};

use crate::error::{Error, Result};
use crate::lake::{LiveEntry, S_BATCH_ID, S_LVI, Table, hint_uri, metadata_uri};
use crate::lvi;

/// Above this many manifests, an append merges the existing ones into one, keeping scan planning
/// to a handful of reads no matter how many commits a table has seen.
const MERGE_MANIFESTS_AT: usize = 8;
const MAX_ATTEMPTS: usize = 10;

pub(crate) enum Change {
    /// New data files (and the newest row per series among them, for the last-value index).
    Append { files: Vec<DataFile>, latest: Option<RecordBatch> },
    /// Remove files and add files with the same rows (compaction): `Operation::Replace`.
    Replace { removed: Vec<LiveEntry>, added: Vec<DataFile> },
    /// Remove files (retention): `Operation::Delete`. The last-value index drops series whose
    /// newest row is older than `lvi_cutoff` (µs since the epoch).
    Delete { removed: Vec<LiveEntry>, lvi_cutoff: Option<i64> },
}

#[derive(Clone, Debug)]
pub struct CommitInfo {
    pub snapshot_id: i64,
    pub version: u64,
    pub attempts: usize,
    pub duration: Duration,
    /// True if the batch id was already committed and nothing was written.
    pub duplicate: bool,
}

pub(crate) async fn commit(table: &Table, change: Change, mut props: HashMap<String, String>) -> Result<(Table, CommitInfo)> {
    let t0 = Instant::now();
    let mut base = table.clone();
    for attempt in 1..=MAX_ATTEMPTS {
        if attempt > 1 {
            base = base.refresh().await?;
            tokio::time::sleep(Duration::from_millis(rand::random_range(5..50) * attempt as u64)).await;
        }
        // Idempotency: an append whose batch id is already in the history is a no-op.
        if let (Change::Append { .. }, Some(id)) = (&change, props.get(S_BATCH_ID))
            && base.metadata.snapshots().any(|s| s.summary().additional_properties.get(S_BATCH_ID) == Some(id))
        {
            let info = CommitInfo {
                snapshot_id: base.metadata.current_snapshot_id().unwrap_or_default(),
                version: base.version,
                attempts: attempt,
                duration: t0.elapsed(),
                duplicate: true,
            };
            return Ok((base, info));
        }
        let mut written = vec![];
        match try_commit(&base, &change, &mut props, &mut written).await {
            Ok(Some((t, snapshot_id))) => {
                let info = CommitInfo { snapshot_id, version: t.version, attempts: attempt, duration: t0.elapsed(), duplicate: false };
                return Ok((t, info));
            }
            Ok(None) => {
                // Lost the race: drop what this attempt wrote and rebase.
                let _ = base.lake.storage().delete_many(written).await;
            }
            Err(e) => {
                let _ = base.lake.storage().delete_many(written).await;
                return Err(e);
            }
        }
    }
    Err(Error::Conflict(format!("{}: gave up after {MAX_ATTEMPTS} attempts", table.name)))
}

/// One attempt against `base`. `Ok(None)` means another writer committed first.
async fn try_commit(
    base: &Table,
    change: &Change,
    props: &mut HashMap<String, String>,
    written: &mut Vec<String>,
) -> Result<Option<(Table, i64)>> {
    let meta = &base.metadata;
    let storage = base.lake.storage();
    let mut snapshot_id = rand::random_range(1..i64::MAX);
    while meta.snapshot_by_id(snapshot_id).is_some() {
        snapshot_id = rand::random_range(1..i64::MAX);
    }
    let parent = meta.current_snapshot_id();
    let seq = meta.next_sequence_number();
    let schema = meta.current_schema().clone();
    let spec = (**meta.default_partition_spec()).clone();
    let manifest_uri = |kind: &str| format!("{}/metadata/{}-{kind}-m.avro", base.location, uuid::Uuid::new_v4());
    let new_writer = |uri: &str| {
        ManifestWriterBuilder::new(storage.output_file(uri), Some(snapshot_id), schema.clone(), spec.clone()).build_v2_data()
    };

    let current = base.manifests().await?;
    let (added, removed): (&[DataFile], &[LiveEntry]) = match change {
        Change::Append { files, .. } => (files, &[]),
        Change::Replace { removed, added } => (added, removed),
        Change::Delete { removed, .. } => (&[], removed),
    };
    let removed_paths: HashSet<&str> = removed.iter().map(|e| e.data_file.file_path()).collect();

    // Manifests and the last-value index don't depend on each other: write them concurrently.
    let base_props = base.current_snapshot().map(|s| s.summary().additional_properties.clone()).unwrap_or_default();
    let manifests = write_manifests(base, &current, added, &removed_paths, snapshot_id, seq, &manifest_uri, &new_writer);
    let index = last_value_index(base, change, snapshot_id, &base_props);
    let (m, (lvi_uri, new_lvi)) = futures::try_join!(manifests, index)?;
    let ManifestsOut { new_manifests, carried, entries, found, written: w } = m;
    written.extend(w);
    if let Some((uri, _)) = &new_lvi {
        written.push(uri.clone());
    }
    if let Some(uri) = lvi_uri {
        props.insert(S_LVI.into(), uri);
    }
    if found != removed_paths.len() {
        return Err(Error::Conflict(format!(
            "{}: {} of {} files to remove are no longer in the table (concurrent maintenance?)",
            base.name,
            removed_paths.len() - found,
            removed_paths.len()
        )));
    }

    // Snapshot summary with Iceberg's standard counters.
    let num = |k: &str| base_props.get(k).and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    let (add_files, add_rows, add_bytes) = (
        added.len() as i64,
        added.iter().map(|f| f.record_count() as i64).sum::<i64>(),
        added.iter().map(|f| f.file_size_in_bytes() as i64).sum::<i64>(),
    );
    let (del_files, del_rows, del_bytes) = (
        removed.len() as i64,
        removed.iter().map(|e| e.data_file.record_count() as i64).sum::<i64>(),
        removed.iter().map(|e| e.data_file.file_size_in_bytes() as i64).sum::<i64>(),
    );
    let mut summary = props.clone();
    for (k, v) in [
        ("added-data-files", add_files),
        ("added-records", add_rows),
        ("added-files-size", add_bytes),
        ("deleted-data-files", del_files),
        ("deleted-records", del_rows),
        ("removed-files-size", del_bytes),
        ("total-data-files", num("total-data-files") + add_files - del_files),
        ("total-records", num("total-records") + add_rows - del_rows),
        ("total-files-size", num("total-files-size") + add_bytes - del_bytes),
        ("total-delete-files", 0),
        ("total-position-deletes", 0),
        ("total-equality-deletes", 0),
    ] {
        if v != 0 || k.starts_with("total") {
            summary.insert(k.into(), v.to_string());
        }
    }
    let operation = match change {
        Change::Append { .. } => Operation::Append,
        Change::Replace { .. } => Operation::Replace,
        Change::Delete { .. } => Operation::Delete,
    };

    // Manifest list: new manifests first, then carried ones.
    let list_uri = format!("{}/metadata/snap-{snapshot_id}-{}.avro", base.location, uuid::Uuid::new_v4());
    let mut lw = ManifestListWriter::v2(storage.output_file(&list_uri).writer().await?, snapshot_id, parent, seq);
    let list_files: Vec<ManifestFile> = new_manifests.into_iter().chain(carried).collect();
    lw.add_manifests(list_files.clone().into_iter())?;
    lw.close().await?;
    written.push(list_uri.clone());

    let snapshot = Snapshot::builder()
        .with_snapshot_id(snapshot_id)
        .with_parent_snapshot_id(parent)
        .with_sequence_number(seq)
        .with_timestamp_ms(chrono::Utc::now().timestamp_millis())
        .with_manifest_list(list_uri)
        .with_summary(Summary { operation, additional_properties: summary })
        .with_schema_id(meta.current_schema_id())
        .build();
    let new_meta = TableMetadataBuilder::new_from_metadata((**meta).clone(), Some(metadata_uri(&base.location, base.version)))
        .set_branch_snapshot(snapshot, "main")?
        .build()?
        .metadata;
    let Some(t) = publish(base, new_meta).await? else { return Ok(None) };
    // Prime the caches with what this commit wrote, so the next commit and inline maintenance
    // don't read it back from object storage.
    for (path, es) in entries {
        base.lake.cache_manifest(path, es);
    }
    let list: Vec<ManifestFile> = list_files
        .into_iter()
        .map(|mut mf| {
            if mf.sequence_number == UNASSIGNED_SEQUENCE_NUMBER {
                mf.sequence_number = seq;
            }
            if mf.min_sequence_number == UNASSIGNED_SEQUENCE_NUMBER {
                mf.min_sequence_number = seq;
            }
            mf
        })
        .collect();
    base.lake.cache_manifest_list(t.current_snapshot().unwrap().manifest_list().to_string(), list);
    if let Some((uri, batch)) = new_lvi {
        base.lake.cache_lvi(uri, batch);
    }
    Ok(Some((t, snapshot_id)))
}

struct ManifestsOut {
    new_manifests: Vec<ManifestFile>,
    carried: Vec<ManifestFile>,
    /// Entries of each manifest written, for the cache.
    entries: Vec<(String, Vec<LiveEntry>)>,
    /// How many of the files to remove were found.
    found: usize,
    written: Vec<String>,
}

#[allow(clippy::too_many_arguments)]
async fn write_manifests(
    base: &Table,
    current: &[ManifestFile],
    added: &[DataFile],
    removed_paths: &HashSet<&str>,
    snapshot_id: i64,
    seq: i64,
    manifest_uri: &(dyn Fn(&str) -> String + Sync),
    new_writer: &(dyn Fn(&str) -> iceberg::spec::ManifestWriter + Sync),
) -> Result<ManifestsOut> {
    let mut out = ManifestsOut { new_manifests: vec![], carried: vec![], entries: vec![], found: 0, written: vec![] };
    if !added.is_empty() {
        let uri = manifest_uri("added");
        let mut w = new_writer(&uri);
        let mut es = vec![];
        for f in added {
            w.add_file(f.clone(), UNASSIGNED_SEQUENCE_NUMBER)?;
            es.push(LiveEntry {
                status: ManifestStatus::Added,
                data_file: f.clone(),
                snapshot_id,
                sequence_number: seq,
                file_sequence_number: seq,
            });
        }
        out.written.push(uri.clone());
        out.new_manifests.push(w.write_manifest_file().await?);
        out.entries.push((uri, es));
    }

    // Carry existing manifests; rewrite the ones that contain removed files, and merge the rest
    // once there are too many.
    let mut to_rewrite: Vec<ManifestFile> = vec![];
    for mf in current.iter() {
        let touched = if removed_paths.is_empty() {
            false
        } else {
            base.lake.manifest(mf).await?.iter().any(|e| removed_paths.contains(e.data_file.file_path()))
        };
        if touched { to_rewrite.push(mf.clone()) } else { out.carried.push(mf.clone()) }
    }
    if removed_paths.is_empty() && out.carried.len() + out.new_manifests.len() > MERGE_MANIFESTS_AT {
        to_rewrite.append(&mut out.carried);
    }
    if !to_rewrite.is_empty() {
        let (mut kept, mut deleted) = (vec![], vec![]);
        for mf in &to_rewrite {
            for e in base.lake.manifest(mf).await?.iter() {
                if e.status == ManifestStatus::Deleted {
                    continue;
                }
                if removed_paths.contains(e.data_file.file_path()) {
                    out.found += 1;
                    deleted.push(e.clone());
                } else {
                    kept.push(e.clone());
                }
            }
        }
        if !kept.is_empty() {
            let uri = manifest_uri("merged");
            let mut w = new_writer(&uri);
            for e in &kept {
                w.add_existing_file(e.data_file.clone(), e.snapshot_id, e.sequence_number, Some(e.file_sequence_number))?;
            }
            out.written.push(uri.clone());
            out.new_manifests.push(w.write_manifest_file().await?);
            out.entries.push((uri, kept.into_iter().map(|e| LiveEntry { status: ManifestStatus::Existing, ..e }).collect()));
        }
        if !deleted.is_empty() {
            let uri = manifest_uri("deleted");
            let mut w = new_writer(&uri);
            for e in &deleted {
                w.add_delete_file(e.data_file.clone(), e.sequence_number, Some(e.file_sequence_number))?;
            }
            out.written.push(uri.clone());
            out.new_manifests.push(w.write_manifest_file().await?);
            out.entries.push((uri, deleted.into_iter().map(|e| LiveEntry { status: ManifestStatus::Deleted, snapshot_id, ..e }).collect()));
        }
    }
    Ok(out)
}

/// The last-value index for the new snapshot: (location to record, newly written file + batch).
async fn last_value_index(
    base: &Table,
    change: &Change,
    snapshot_id: i64,
    base_props: &HashMap<String, String>,
) -> Result<(Option<String>, Option<(String, RecordBatch)>)> {
    let base_rows: u64 = base_props.get("total-records").and_then(|v| v.parse().ok()).unwrap_or(0);
    Ok(match change {
        Change::Append { latest: Some(latest), .. } => {
            // Only extend an index that covers all existing rows.
            if base.last_value_index().is_some() || base_rows == 0 {
                match lvi::merged(base, latest).await? {
                    Some(idx) => {
                        let uri = lvi::write(base, snapshot_id, &idx).await?;
                        (Some(uri.clone()), Some((uri, idx)))
                    }
                    None => (None, None),
                }
            } else {
                (None, None)
            }
        }
        Change::Append { latest: None, .. } => (None, None),
        Change::Replace { .. } => (base.last_value_index(), None),
        Change::Delete { lvi_cutoff, .. } => match (base.last_value_index(), lvi_cutoff, &base.contract.time_column) {
            (Some(uri), Some(cutoff), Some(tc)) => {
                let idx = lvi::read(base, &uri).await?;
                let ts = arrow::compute::cast(idx.column(idx.schema().index_of(tc)?), &arrow::datatypes::DataType::Int64)?;
                let keep = arrow::compute::kernels::cmp::gt_eq(&ts, &arrow::array::Int64Array::new_scalar(*cutoff))?;
                let idx = arrow::compute::filter_record_batch(&idx, &keep)?;
                let new = lvi::write(base, snapshot_id, &idx).await?;
                (Some(new.clone()), Some((new, idx)))
            }
            (uri, _, _) => (uri, None),
        },
    })
}

/// Commits new table metadata as version N+1. `Ok(None)` if another writer got there first.
pub(crate) async fn publish(base: &Table, new_meta: iceberg::spec::TableMetadata) -> Result<Option<Table>> {
    let storage = base.lake.storage();
    let version = base.version + 1;
    let bytes = Bytes::from(serde_json::to_vec(&new_meta)?);
    if !storage.write_if_absent(&metadata_uri(&base.location, version), bytes).await? {
        return Ok(None);
    }
    storage.write(&hint_uri(&base.location), Bytes::from(version.to_string())).await?;
    let t = Table::new(base.lake.clone(), base.name.clone(), base.location.clone(), version, new_meta)?;
    base.lake.remember(&t);
    Ok(Some(t))
}
