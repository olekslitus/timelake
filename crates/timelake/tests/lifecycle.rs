//! End-to-end table lifecycle on local storage: create, append, query, last-value index and
//! query rewrite, compaction with dedup, retention, snapshot expiry, concurrent commits.

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, Float64Array, Int32Array, Int64Array, RecordBatch, StringArray, TimestampMicrosecondArray};
use arrow::datatypes::{DataType, Field, Schema, TimeUnit};
use timelake::{AppendOptions, Lake, MaintainOptions, Session, TableOptions};

const DAY: i64 = 86_400_000_000;
const T0: i64 = 1_767_225_600_000_000; // 2026-01-01T00:00:00Z

fn schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("time", DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())), false),
        Field::new("device", DataType::Int32, true),
        Field::new("site", DataType::Utf8, true),
        Field::new("value", DataType::Float64, true),
    ]))
}

/// `devices` devices, one point every `step` µs from `start`, `n` points each, in time order.
fn batch(start: i64, n: i64, step: i64, devices: i32, value: impl Fn(i32, i64) -> f64) -> RecordBatch {
    let (mut t, mut d, mut s, mut v) = (vec![], vec![], vec![], vec![]);
    for i in 0..n {
        for dev in 0..devices {
            t.push(start + i * step);
            d.push(dev);
            s.push(format!("site-{}", dev % 3));
            v.push(value(dev, i));
        }
    }
    RecordBatch::try_new(
        schema(),
        vec![
            Arc::new(TimestampMicrosecondArray::from(t).with_timezone("UTC")),
            Arc::new(Int32Array::from(d)),
            Arc::new(StringArray::from(s)),
            Arc::new(Float64Array::from(v)),
        ],
    )
    .unwrap()
}

fn opts() -> TableOptions {
    TableOptions { time_column: Some("time".into()), series_key: vec!["device".into()], ..Default::default() }
}

async fn scalar_i64(s: &Session, sql: &str) -> i64 {
    let b = s.sql(sql).await.unwrap().collect().await.unwrap();
    let c = arrow::compute::cast(b[0].column(0), &DataType::Int64).unwrap();
    c.as_any().downcast_ref::<Int64Array>().unwrap().value(0)
}

async fn explain(s: &Session, sql: &str) -> String {
    let b = s.sql(&format!("EXPLAIN {sql}")).await.unwrap().collect().await.unwrap();
    arrow::util::pretty::pretty_format_batches(&b).unwrap().to_string()
}

fn tmp() -> tempdir::Dir {
    tempdir::Dir::new()
}

mod tempdir {
    pub struct Dir(pub std::path::PathBuf);
    impl Dir {
        pub fn new() -> Self {
            let p = std::env::temp_dir().join(format!("timelake-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        pub fn path(&self) -> &str {
            self.0.to_str().unwrap()
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn append_query_latest_compact_expire() {
    let dir = tmp();
    let lake = Lake::open(dir.path(), HashMap::new()).unwrap();
    let mut t = lake.create_table("iot.readings", &schema(), opts()).await.unwrap();
    assert!(lake.create_table("iot.readings", &schema(), opts()).await.is_err());

    // 3 days of data in 12 appends of 6 hours each; no auto-maintenance yet.
    let no_maint = AppendOptions { maintain: Some(false), ..Default::default() };
    for i in 0..12 {
        let b = batch(T0 + i * DAY / 4, 360, 60_000_000, 10, |d, j| d as f64 * 1000.0 + j as f64);
        let (nt, r) = t.append(&[b], no_maint.clone()).await.unwrap();
        assert_eq!(r.rows, 3600);
        t = nt;
    }
    assert_eq!(t.metadata.snapshots().len(), 12);
    assert_eq!(t.files().await.unwrap().len(), 12);
    // Manifests are merged as commits accumulate.
    assert!(t.manifests().await.unwrap().len() <= 9, "{} manifests", t.manifests().await.unwrap().len());

    let s = Session::new(lake.clone());
    assert_eq!(scalar_i64(&s, "SELECT count(*) FROM iot.readings").await, 43_200);
    // File pruning on time: only the files of the last day remain in the plan.
    let plan = explain(&s, "SELECT avg(value) FROM iot.readings WHERE time >= TIMESTAMP '2026-01-03 00:00:00'").await;
    assert!(plan.contains("file_groups={4 groups"), "{plan}");
    assert_eq!(scalar_i64(&s, "SELECT count(*) FROM iot.readings WHERE time >= TIMESTAMP '2026-01-03 00:00:00'").await, 14_400);
    assert_eq!(
        scalar_i64(&s, "SELECT count(*) FROM (SELECT time_bucket(INTERVAL '1 hour', time) h, avg(value) FROM iot.readings GROUP BY 1)").await,
        72
    );

    // Latest per device via the index, and the automatic rewrites.
    let latest = s.latest("iot.readings").await.unwrap().collect().await.unwrap();
    assert_eq!(latest.iter().map(|b| b.num_rows()).sum::<usize>(), 10);
    let rn_sql = "SELECT device, value FROM (SELECT device, value, ROW_NUMBER() OVER (PARTITION BY device ORDER BY time DESC) AS rn FROM iot.readings) WHERE rn = 1 ORDER BY device";
    let plan = explain(&s, rn_sql).await;
    assert!(plan.contains("TimelakeProvider(iot.readings") || !plan.contains("WindowAggr"), "{plan}");
    assert!(!plan.contains("BoundedWindowAggExec") && !plan.contains("WindowAggExec"), "row_number not rewritten:\n{plan}");
    let rows = s.sql(rn_sql).await.unwrap().collect().await.unwrap();
    let v = rows[0].column(1).as_any().downcast_ref::<Float64Array>().unwrap();
    assert_eq!(v.value(3), 3000.0 + 359.0); // device 3, last point of the last append
    // Extra predicates next to rn = 1 (applied after picking the latest row) still use the index.
    let rn_and = "SELECT device FROM (SELECT device, value, ROW_NUMBER() OVER (PARTITION BY device ORDER BY time DESC) AS rn FROM iot.readings) WHERE rn = 1 AND value > 5000";
    let plan = explain(&s, rn_and).await;
    assert!(!plan.contains("WindowAggExec"), "rn = 1 AND … not rewritten:\n{plan}");
    assert_eq!(scalar_i64(&s, &format!("SELECT count(*) FROM ({rn_and})")).await, 5);
    let top1 = "SELECT time, value FROM iot.readings WHERE device = 7 ORDER BY time DESC LIMIT 1";
    let plan = explain(&s, top1).await;
    assert!(plan.contains("DataSourceExec: partitions=1, partition_sizes=[1]"), "top-1 not rewritten:\n{plan}");
    let r = s.sql(top1).await.unwrap().collect().await.unwrap();
    assert_eq!(r[0].column(1).as_any().downcast_ref::<Float64Array>().unwrap().value(0), 7359.0);
    // Filters on non-key columns must not use the index.
    let plan = explain(&s, "SELECT time FROM iot.readings WHERE value < 5 ORDER BY time DESC LIMIT 1").await;
    assert!(plan.contains("ParquetSource") || plan.contains("file_type=parquet"), "{plan}");

    // Duplicates + late data, then compaction dedups (latest write wins).
    let dup = batch(T0, 10, 60_000_000, 10, |_, _| -1.0);
    let (nt, _) = t.append(&[dup], no_maint.clone()).await.unwrap();
    t = nt;
    assert_eq!(scalar_i64(&s, "SELECT count(*) FROM iot.readings").await, 43_300);
    let (nt, rep) = t.maintain(MaintainOptions { expire: false, ..Default::default() }).await.unwrap();
    t = nt;
    assert_eq!(rep.partitions_compacted, 3, "{rep:?}");
    assert_eq!(rep.duplicates_removed, 100, "{rep:?}");
    assert_eq!(t.files().await.unwrap().len(), 3);
    assert_eq!(scalar_i64(&s, "SELECT count(*) FROM iot.readings").await, 43_200);
    assert_eq!(scalar_i64(&s, "SELECT count(*) FROM iot.readings WHERE value = -1").await, 100);
    // Compaction keeps the index.
    assert!(t.last_value_index().is_some());
    // Single-device query reads sorted files; result is correct.
    assert_eq!(scalar_i64(&s, "SELECT count(*) FROM iot.readings WHERE device = 4").await, 4320);

    // Expire everything but the current snapshot: the replaced small files are deleted.
    let mut props = t.metadata.properties().clone();
    props.insert("timelake.snapshot-retention".into(), "0s".into());
    props.insert("timelake.min-snapshots".into(), "1".into());
    let mut contract = t.contract.clone();
    contract.snapshot_retention = std::time::Duration::ZERO;
    contract.min_snapshots = 1;
    t.contract = contract;
    let (t2, rep) = t.maintain(MaintainOptions { compact: false, ..Default::default() }).await.unwrap();
    assert_eq!(rep.snapshots_expired, 13, "{rep:?}");
    assert!(rep.objects_deleted >= 13, "{rep:?}");
    assert_eq!(t2.metadata.snapshots().len(), 1);
    let data_files = std::fs::read_dir(std::path::Path::new(dir.path()).join("iot/readings/data"))
        .unwrap()
        .flat_map(|d| std::fs::read_dir(d.unwrap().path()).unwrap())
        .count();
    assert_eq!(data_files, 3);
    assert_eq!(scalar_i64(&s, "SELECT count(*) FROM iot.readings").await, 43_200);
}

#[tokio::test(flavor = "multi_thread")]
async fn auto_maintain_retention_idempotency_concurrency() {
    let dir = tmp();
    let lake = Lake::open(dir.path(), HashMap::new()).unwrap();
    let mut o = opts();
    o.properties.insert("timelake.compact-min-files".into(), "4".into());
    o.retention = Some("3650d".into());
    let mut t = lake.create_table("m", &schema(), o).await.unwrap();

    // Auto-maintenance compacts once 4 small files accumulate in a partition.
    let now = chrono::Utc::now().timestamp_micros() / DAY * DAY;
    let mut compactions = 0;
    for i in 0..9 {
        let (nt, r) = t.append(&[batch(now + i * 60_000_000, 1, 1, 5, |_, _| i as f64)], Default::default()).await.unwrap();
        compactions += r.maintenance.is_some() as usize;
        t = nt;
    }
    assert_eq!(compactions, 2);
    assert!(t.files().await.unwrap().len() <= 3);

    // Idempotent batch ids.
    let b = batch(now + DAY / 2, 1, 1, 5, |_, _| 0.0);
    let id = AppendOptions { batch_id: Some("batch-42".into()), maintain: Some(false), ..Default::default() };
    let (t1, r1) = t.append(&[b.clone()], id.clone()).await.unwrap();
    let (t2, r2) = t1.append(&[b], id).await.unwrap();
    assert!(!r1.commit.duplicate && r2.commit.duplicate);
    assert_eq!(t1.version, t2.version);

    // Concurrent appends against the same base all land.
    let base = t2.clone();
    let handles: Vec<_> = (0..8)
        .map(|i| {
            let base = base.clone();
            tokio::spawn(async move {
                let b = batch(now + DAY / 3 + i * 1000, 1, 1, 5, |_, _| 1.0);
                base.append(&[b], AppendOptions { maintain: Some(false), ..Default::default() }).await.map(|(_, r)| r.commit.attempts)
            })
        })
        .collect();
    for h in handles {
        h.await.unwrap().unwrap();
    }
    let t3 = lake.table("m").await.unwrap();
    let s = Session::new(lake.clone());
    assert_eq!(scalar_i64(&s, "SELECT count(*) FROM m").await, 45 + 5 + 40);
    assert_eq!(t3.version, t2.version + 8);

    // Retention drops partitions older than the window.
    let old = batch(T0 - 4000 * DAY, 2, 1, 5, |_, _| 9.0);
    let (t4, _) = t3.append(&[old], AppendOptions { maintain: Some(false), ..Default::default() }).await.unwrap();
    assert_eq!(scalar_i64(&s, "SELECT count(*) FROM m").await, 100);
    let (_, rep) = t4.maintain(MaintainOptions { compact: false, expire: false, ..Default::default() }).await.unwrap();
    assert_eq!(rep.partitions_dropped, 1);
    assert_eq!(scalar_i64(&s, "SELECT count(*) FROM m").await, 90);
}

#[tokio::test(flavor = "multi_thread")]
async fn dimension_tables_and_schema_alignment() {
    let dir = tmp();
    let lake = Lake::open(dir.path(), HashMap::new()).unwrap();
    let tags = Arc::new(Schema::new(vec![Field::new("id", DataType::Int32, true), Field::new("name", DataType::Utf8, true)]));
    let t = lake.create_table("iot.tags", &tags, TableOptions::default()).await.unwrap();
    let b = RecordBatch::try_new(tags.clone(), vec![Arc::new(Int32Array::from(vec![1, 2])), Arc::new(StringArray::from(vec!["a", "b"]))]).unwrap();
    t.append(&[b], Default::default()).await.unwrap();

    // Columns in another order and a missing nullable column are fine; unknown columns are not.
    let r = lake.create_table("iot.r", &schema(), opts()).await.unwrap();
    let partial = Arc::new(Schema::new(vec![
        Field::new("device", DataType::Int64, true),
        Field::new("time", DataType::Timestamp(TimeUnit::Millisecond, None), false),
    ]));
    let b = RecordBatch::try_new(
        partial,
        vec![Arc::new(Int64Array::from(vec![1, 2])), Arc::new(arrow::array::TimestampMillisecondArray::from(vec![T0 / 1000, T0 / 1000]))],
    )
    .unwrap();
    r.append(&[b], Default::default()).await.unwrap();

    let s = Session::new(lake.clone());
    assert_eq!(scalar_i64(&s, "SELECT count(*) FROM iot.r r JOIN iot.tags t ON r.device = t.id WHERE t.name = 'b'").await, 1);
    let mut names: Vec<_> = lake.all_tables().await.unwrap().into_iter().map(|t| t.to_string()).collect();
    names.sort();
    assert_eq!(names, vec!["iot.r", "iot.tags"]);
}
