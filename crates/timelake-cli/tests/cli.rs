//! Smoke test of the `timelake` binary on a temporary local warehouse.

#![allow(clippy::unwrap_used, reason = "test code")]

use std::path::Path;
use std::process::Command;

/// Runs `timelake -w <warehouse> <args…>` and returns stdout and stderr; panics if it fails.
fn timelake(warehouse: &Path, args: &[&str]) -> (String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_timelake"))
        .arg("--warehouse")
        .arg(warehouse)
        .args(args)
        .env_remove("TIMELAKE_WAREHOUSE")
        .output()
        .unwrap();
    let (stdout, stderr) = (String::from_utf8(out.stdout).unwrap(), String::from_utf8(out.stderr).unwrap());
    assert!(out.status.success(), "timelake {args:?} failed:\n{stderr}");
    (stdout, stderr)
}

#[test]
fn create_import_query_maintain() {
    let dir = tempfile::tempdir().unwrap();
    let warehouse = dir.path().join("warehouse");
    let csv = dir.path().join("readings.csv");
    std::fs::write(
        &csv,
        "time,device,value\n\
         2026-01-01T00:00:00Z,1,1.5\n\
         2026-01-01T00:01:00Z,1,2.5\n\
         2026-01-01T00:00:00Z,2,10.0\n\
         2026-01-02T00:00:00Z,2,11.0\n",
    )
    .unwrap();
    let csv = csv.to_str().unwrap();

    let (out, _) =
        timelake(&warehouse, &["import", "iot.readings", csv, "--time-column", "time", "--series-key", "device"]);
    assert!(out.contains("iot.readings: appended 4 rows in 1 commits"), "{out}");

    let (out, _) = timelake(&warehouse, &["ls"]);
    assert_eq!(out.trim(), "iot.readings");

    // Statements are split by the SQL parser, so a ';' inside a string literal stays put.
    let (out, _) = timelake(
        &warehouse,
        &["sql", "--format", "csv", "SELECT 'a;b' AS s; SELECT count(*) AS n FROM iot.readings WHERE device = 2"],
    );
    assert_eq!(out, "s\na;b\nn\n2\n");

    let (out, _) = timelake(&warehouse, &["latest", "iot.readings", "--format", "json"]);
    assert_eq!(out.lines().count(), 2, "{out}");
    assert!(out.contains(r#""value":2.5"#) && out.contains(r#""value":11.0"#), "{out}");

    // Appending the same batch id again is skipped and reported as such.
    let (out, _) = timelake(&warehouse, &["append", "iot.readings", csv, "--batch-id", "b1"]);
    assert!(out.contains("appended 4 rows in 1 commits"), "{out}");
    let (out, err) = timelake(&warehouse, &["append", "iot.readings", csv, "--batch-id", "b1"]);
    assert!(out.contains("appended 0 rows in 0 commits, skipped 1 duplicate batch,"), "{out}");
    assert!(err.contains("duplicate batch, skipped"), "{err}");

    let (out, _) = timelake(&warehouse, &["maintain"]);
    assert!(out.starts_with("iot.readings: compacted 2 partitions"), "{out}");

    let (out, _) = timelake(&warehouse, &["info", "iot.readings", "--json"]);
    let info: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(info["rows"], 4, "{info}");
    assert_eq!(info["series_key"], serde_json::json!(["device"]));
    assert_eq!(info["partitions"].as_array().unwrap().len(), 2);

    let (out, _) = timelake(&warehouse, &["info", "iot.readings"]);
    assert!(out.contains("data       4 rows in 2 files"), "{out}");

    let (out, _) = timelake(&warehouse, &["drop", "iot.readings"]);
    assert_eq!(out.trim(), "dropped iot.readings");
}
