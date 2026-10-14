//! Helpers shared by the integration tests: a small IoT schema, generated batches, and SQL shortcuts.

#![allow(dead_code, reason = "each test binary uses a different subset")]

use std::sync::Arc;

use arrow::array::{Array, Float64Array, Int32Array, Int64Array, RecordBatch, StringArray, TimestampMicrosecondArray};
use arrow::datatypes::{DataType, Field, Schema, TimeUnit};
use timelake::{Lake, Session, TableOptions};

pub(crate) const DAY: i64 = 86_400_000_000;
pub(crate) const T0: i64 = 1_767_225_600_000_000; // 2026-01-01T00:00:00Z

pub(crate) fn schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("time", DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())), false),
        Field::new("device", DataType::Int32, true),
        Field::new("site", DataType::Utf8, true),
        Field::new("value", DataType::Float64, true),
    ]))
}

/// `devices` devices, one point every `step` µs from `start`, `n` points each, in time order.
pub(crate) fn batch(start: i64, n: i64, step: i64, devices: i32, value: impl Fn(i32, i64) -> f64) -> RecordBatch {
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

/// A time-series table keyed by device.
pub(crate) fn opts() -> TableOptions {
    TableOptions { time_column: Some("time".into()), series_key: vec!["device".into()], ..Default::default() }
}

/// A lake in a fresh temporary directory (deleted when the guard drops).
pub(crate) fn temp_lake() -> (tempfile::TempDir, Lake) {
    let dir = tempfile::tempdir().unwrap();
    let lake = Lake::open(dir.path().to_str().unwrap(), Default::default()).unwrap();
    (dir, lake)
}

pub(crate) async fn rows(s: &Session, sql: &str) -> Vec<RecordBatch> {
    s.sql(sql).await.unwrap().collect().await.unwrap()
}

/// The first value of the first column, as i64.
pub(crate) async fn scalar_i64(s: &Session, sql: &str) -> i64 {
    let b = rows(s, sql).await;
    let c = arrow::compute::cast(b[0].column(0), &DataType::Int64).unwrap();
    c.as_any().downcast_ref::<Int64Array>().unwrap().value(0)
}

/// One string column of a result, concatenated across batches.
pub(crate) fn strings(batches: &[RecordBatch], column: &str) -> Vec<String> {
    batches
        .iter()
        .flat_map(|b| {
            let c = arrow::compute::cast(b.column_by_name(column).unwrap(), &DataType::Utf8).unwrap();
            let c = c.as_any().downcast_ref::<StringArray>().unwrap().clone();
            (0..c.len()).map(move |i| c.value(i).to_string())
        })
        .collect()
}
