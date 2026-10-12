//! Phase 0 spike for SPEC.md Q7: how far does iceberg-rust get us on the time-series write path?
//!
//! Exercises: table creation with a Timelake-style contract, partitioned + sorted Parquet writes,
//! bulk and small "live" commits, late data, custom snapshot summary properties, concurrent
//! commits, and time/series pruning during scan planning.
//!
//! Usage: cargo run --release -p spike-iceberg-write -- [v2|v3] [live-commits]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use arrow_array::{ArrayRef, Float64Array, Int32Array, RecordBatch, StringArray, TimestampMicrosecondArray};
use futures::TryStreamExt;
use iceberg::arrow::{RecordBatchPartitionSplitter, schema_to_arrow_schema};
use iceberg::expr::Reference;
use iceberg::io::LocalFsStorageFactory;
use iceberg::memory::{MEMORY_CATALOG_WAREHOUSE, MemoryCatalogBuilder};
use iceberg::spec::{
    DataFile, DataFileFormat, Datum, FormatVersion, NestedField, NullOrder, PrimitiveType, Schema,
    SortDirection, SortField, SortOrder, Transform, Type, UnboundPartitionSpec,
};
use iceberg::table::Table;
use iceberg::transaction::{ApplyTransactionAction, Transaction};
use iceberg::writer::base_writer::data_file_writer::DataFileWriterBuilder;
use iceberg::writer::file_writer::ParquetWriterBuilder;
use iceberg::writer::file_writer::location_generator::{DefaultFileNameGenerator, DefaultLocationGenerator};
use iceberg::writer::file_writer::rolling_writer::RollingFileWriterBuilder;
use iceberg::writer::partitioning::PartitioningWriter;
use iceberg::writer::partitioning::fanout_writer::FanoutWriter;
use iceberg::{Catalog, CatalogBuilder, NamespaceIdent, TableCreation, TableIdent};
use parquet::basic::Compression;
use parquet::file::properties::WriterProperties;

const DEVICES: usize = 500;
const METRICS: [&str; 4] = ["temp", "pressure", "rpm", "vibration"];
const POINTS_PER_DAY: i64 = 96; // one point every 15 minutes
const DAY_US: i64 = 86_400_000_000;
const NOW_US: i64 = 1_791_158_400_000_000; // 2026-10-05T00:00:00Z

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let version = match args.get(1).map(String::as_str) {
        Some("v3") => FormatVersion::V3,
        _ => FormatVersion::V2,
    };
    let live_commits: usize = args.get(2).map(|s| s.parse()).transpose()?.unwrap_or(100);

    let root = std::env::current_dir()?.join("spike-data").join(format!("{version:?}").to_lowercase());
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root)?;
    let warehouse = root.join("warehouse");

    let catalog = MemoryCatalogBuilder::default()
        .with_storage_factory(Arc::new(LocalFsStorageFactory))
        .load(
            "spike",
            HashMap::from([(MEMORY_CATALOG_WAREHOUSE.to_string(), format!("file://{}", warehouse.display()))]),
        )
        .await?;

    println!("== iceberg-rust 0.10.1 spike, format {version:?}, warehouse {}", warehouse.display());

    // --- 1. Create a table that follows the Timelake contract (SPEC §7.1).
    let ns = NamespaceIdent::new("iot".into());
    catalog.create_namespace(&ns, HashMap::new()).await?;
    let schema = Schema::builder()
        .with_fields(vec![
            NestedField::required(1, "device_id", Type::Primitive(PrimitiveType::String)).into(),
            NestedField::required(2, "metric", Type::Primitive(PrimitiveType::String)).into(),
            NestedField::required(3, "ts", Type::Primitive(PrimitiveType::Timestamptz)).into(),
            NestedField::optional(4, "value", Type::Primitive(PrimitiveType::Double)).into(),
            NestedField::optional(5, "quality", Type::Primitive(PrimitiveType::Int)).into(),
        ])
        .build()?;
    let spec = UnboundPartitionSpec::builder().add_partition_field(3, "ts_day", Transform::Day)?.build();
    let sort_field = |id| SortField {
        source_id: id,
        transform: Transform::Identity,
        direction: SortDirection::Ascending,
        null_order: NullOrder::First,
    };
    let sort_order = SortOrder::builder()
        .with_order_id(1)
        .with_sort_field(sort_field(1))
        .with_sort_field(sort_field(2))
        .with_sort_field(sort_field(3))
        .build(&schema)?;
    let creation = TableCreation::builder()
        .name("sensor".into())
        .schema(schema)
        .partition_spec(spec)
        .sort_order(sort_order)
        .format_version(version)
        .properties([
            ("timelake.time-column".to_string(), "ts".to_string()),
            ("timelake.series-key".to_string(), "device_id,metric".to_string()),
            ("write.parquet.compression-codec".to_string(), "zstd".to_string()),
        ])
        .build();
    let ident = TableIdent::new(ns.clone(), "sensor".into());
    let mut table = catalog.create_table(&ns, creation).await?;
    report("create table", true, "");

    // --- 2. Bulk load 3 days of history in one commit.
    let t = Instant::now();
    let batch = gen_batch(&table, NOW_US - 3 * DAY_US, 3 * POINTS_PER_DAY, DAY_US / POINTS_PER_DAY)?;
    let rows = batch.num_rows();
    let files = write_partitioned(&table, batch, "bulk").await?;
    let n_files = files.len();
    table = commit(&table, &catalog, files, &[("timelake.batch-id", "bulk-0")]).await?;
    report(
        "bulk write + commit",
        true,
        &format!("{rows} rows -> {n_files} files in {:?}", t.elapsed()),
    );

    // --- 3. Many small "live" commits (what continuous ingestion without a hot tier looks like).
    let mut latencies = Vec::with_capacity(live_commits);
    for i in 0..live_commits {
        let ts = NOW_US + i as i64 * 60_000_000;
        let batch = gen_batch(&table, ts, 1, 0)?;
        let files = write_partitioned(&table, batch, &format!("live-{i}")).await?;
        let t = Instant::now();
        let offset = i.to_string();
        table = commit(&table, &catalog, files, &[("timelake.wal.high-water", &offset)]).await?;
        latencies.push(t.elapsed());
    }
    let (first, last) = (avg(&latencies[..10.min(live_commits)]), avg(&latencies[live_commits.saturating_sub(10)..]));
    report(
        "small live commits",
        true,
        &format!(
            "{live_commits} commits; commit latency first-10 avg {first:?}, last-10 avg {last:?}; metadata dir {} files / {} KiB",
            count_files(&table_dir(&warehouse).join("metadata")),
            dir_size(&table_dir(&warehouse).join("metadata")) / 1024
        ),
    );

    // --- 4. Late data: 2000 points from 30 days ago land in their own (old) partition.
    let batch = gen_batch(&table, NOW_US - 30 * DAY_US, 1, 0)?;
    let files = write_partitioned(&table, batch, "late").await?;
    table = commit(&table, &catalog, files, &[("timelake.changed-ranges", "2026-09-05")]).await?;
    report("late data commit", true, "written into ts_day=2026-09-05");

    // --- 5. Custom snapshot summary properties (watermarks, batch ids, changed ranges; SPEC §5.1).
    let summary = &table.metadata().current_snapshot().context("no snapshot")?.summary().additional_properties;
    let kept = summary.contains_key("timelake.changed-ranges");
    report("custom snapshot summary props", kept, &format!("{:?}", summary.get("timelake.changed-ranges")));

    // --- 6. Concurrent writers: two commits prepared against the same stale table state.
    let stale = catalog.load_table(&ident).await?;
    let f1 = write_partitioned(&stale, gen_batch(&stale, NOW_US + DAY_US, 1, 0)?, "conc-a").await?;
    let f2 = write_partitioned(&stale, gen_batch(&stale, NOW_US + DAY_US + 1, 1, 0)?, "conc-b").await?;
    let a = commit(&stale, &catalog, f1, &[]).await;
    let b = commit(&stale, &catalog, f2, &[]).await;
    report(
        "conflicting appends (stale base) both land",
        a.is_ok() && b.is_ok(),
        &format!("a: {}, b: {}", ok_or_err(&a), ok_or_err(&b)),
    );
    let parallel: Vec<_> = (0..8)
        .map(|i| {
            let (catalog, stale) = (&catalog, stale.clone());
            async move {
                let batch = gen_batch(&stale, NOW_US + 2 * DAY_US + i, 1, 0)?;
                let files = write_partitioned(&stale, batch, &format!("par-{i}")).await?;
                commit(&stale, catalog, files, &[]).await
            }
        })
        .collect();
    let results = futures::future::join_all(parallel).await;
    let ok = results.iter().filter(|r| r.is_ok()).count();
    let err = results.iter().find_map(|r| r.as_ref().err()).map(|e| format!("{e:#}")).unwrap_or_default();
    report("8 parallel appends", ok == 8, &format!("{ok}/8 succeeded {}", truncate(&err, 160)));
    table = catalog.load_table(&ident).await?;

    // --- 7. Scan planning: does time / series filtering prune files?
    let total = plan(&table, None).await?;
    let last_day = Reference::new("ts").greater_than_or_equal_to(Datum::timestamptz_micros(NOW_US - DAY_US));
    let one_device = last_day.clone().and(Reference::new("device_id").equal_to(Datum::string("dev-0007")));
    let by_time = plan(&table, Some(last_day)).await?;
    let by_series = plan(&table, Some(one_device)).await?;
    report(
        "scan planning prunes by time",
        by_time < total,
        &format!("all={total} files, last-day={by_time}, last-day+device={by_series}"),
    );

    // --- 8. Capabilities we need but that have no public API (checked statically, see README).
    println!("\nmetadata for DuckDB: {}", table.metadata_location().unwrap_or("?"));
    Ok(())
}

/// One point per (device, metric) per step, ordered by (device_id, metric, ts) like Timelake's sort order.
fn gen_batch(table: &Table, start_us: i64, steps: i64, step_us: i64) -> Result<RecordBatch> {
    let schema = Arc::new(schema_to_arrow_schema(table.metadata().current_schema())?);
    let n = DEVICES * METRICS.len() * steps as usize;
    let (mut dev, mut met, mut ts, mut val, mut q) =
        (Vec::with_capacity(n), Vec::with_capacity(n), Vec::with_capacity(n), Vec::with_capacity(n), Vec::with_capacity(n));
    for d in 0..DEVICES {
        for (m, metric) in METRICS.iter().enumerate() {
            for s in 0..steps {
                dev.push(format!("dev-{d:04}"));
                met.push(*metric);
                ts.push(start_us + s * step_us);
                val.push((d * 7 + m) as f64 + (s as f64 / 10.0).sin());
                q.push(192);
            }
        }
    }
    let columns: Vec<ArrayRef> = vec![
        Arc::new(StringArray::from(dev)),
        Arc::new(StringArray::from(met)),
        Arc::new(TimestampMicrosecondArray::from(ts).with_timezone("+00:00")),
        Arc::new(Float64Array::from(val)),
        Arc::new(Int32Array::from(q)),
    ];
    Ok(RecordBatch::try_new(schema, columns)?)
}

async fn write_partitioned(table: &Table, batch: RecordBatch, prefix: &str) -> Result<Vec<DataFile>> {
    let meta = table.metadata();
    let props = WriterProperties::builder()
        .set_compression(Compression::ZSTD(Default::default()))
        .build();
    let parquet = ParquetWriterBuilder::new(props, meta.current_schema().clone());
    let rolling = RollingFileWriterBuilder::new_with_default_file_size(
        parquet,
        table.file_io().clone(),
        DefaultLocationGenerator::new(meta)?,
        DefaultFileNameGenerator::new(prefix.to_string(), None, DataFileFormat::Parquet),
    );
    let mut writer = FanoutWriter::new(DataFileWriterBuilder::new(rolling));
    let splitter = RecordBatchPartitionSplitter::try_new_with_computed_values(
        meta.current_schema().clone(),
        meta.default_partition_spec().clone(),
    )?;
    for (key, part) in splitter.split(&batch)? {
        writer.write(key, part).await?;
    }
    Ok(writer.close().await?)
}

async fn commit(table: &Table, catalog: &dyn Catalog, files: Vec<DataFile>, props: &[(&str, &str)]) -> Result<Table> {
    let tx = Transaction::new(table);
    let props = props.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    let tx = tx.fast_append().add_data_files(files).set_snapshot_properties(props).apply(tx)?;
    Ok(tx.commit(catalog).await?)
}

async fn plan(table: &Table, filter: Option<iceberg::expr::Predicate>) -> Result<usize> {
    let mut scan = table.scan();
    if let Some(f) = filter {
        scan = scan.with_filter(f);
    }
    let tasks: Vec<_> = scan.build()?.plan_files().await?.try_collect().await?;
    Ok(tasks.len())
}

fn report(check: &str, ok: bool, detail: &str) {
    println!("[{}] {check}: {detail}", if ok { "PASS" } else { "FAIL" });
}

fn ok_or_err<T>(r: &Result<T>) -> String {
    match r {
        Ok(_) => "ok".into(),
        Err(e) => truncate(&format!("{e:#}"), 160),
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() > n { format!("{}…", &s[..n]) } else { s.to_string() }
}

fn avg(d: &[Duration]) -> Duration {
    d.iter().sum::<Duration>() / d.len().max(1) as u32
}

fn table_dir(warehouse: &Path) -> PathBuf {
    warehouse.join("iot").join("sensor")
}

fn count_files(dir: &Path) -> usize {
    std::fs::read_dir(dir).map(|d| d.count()).unwrap_or(0)
}

fn dir_size(dir: &Path) -> u64 {
    std::fs::read_dir(dir)
        .map(|d| d.filter_map(|e| e.ok()?.metadata().ok()).map(|m| m.len()).sum())
        .unwrap_or(0)
}
