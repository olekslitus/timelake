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

/// Commits the table's metadata again without `timelake.format-version`, as Timelake 0.2 wrote it.
/// Timelake never removes the property itself, so the test edits the metadata files directly.
fn as_written_by_timelake_0_2(metadata: &Path) {
    let version: u64 = std::fs::read_to_string(metadata.join("version-hint.text")).unwrap().trim().parse().unwrap();
    let current = metadata.join(format!("v{version}.metadata.json"));
    let mut doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&current).unwrap()).unwrap();
    doc["properties"].as_object_mut().unwrap().remove("timelake.format-version");
    let next = metadata.join(format!("v{}.metadata.json", version + 1));
    std::fs::write(next, doc.to_string()).unwrap();
    std::fs::write(metadata.join("version-hint.text"), (version + 1).to_string()).unwrap();
}

#[test]
fn settings_and_alter() {
    let dir = tempfile::tempdir().unwrap();
    let warehouse = dir.path().join("warehouse");
    let create = ["create", "iot.r", "--schema", "time:timestamp,device:int", "--time-column", "time"];
    timelake(&warehouse, &[&create[..], &["--series-key", "device", "--prop", "retention=90d"]].concat());

    let (out, _) = timelake(&warehouse, &["settings"]);
    assert!(out.lines().any(|l| l.starts_with("read-dedup ") && l.contains("table,session")), "{out}");
    timelake(&warehouse, &["alter", "iot.r", "--set", "timelake.read_dedup=false", "--unset", "retention"]);
    let (out, _) = timelake(&warehouse, &["settings", "iot.r", "--json"]);
    let settings: serde_json::Value = serde_json::from_str(&out).unwrap();
    let value = |name: &str| settings.as_array().unwrap().iter().find(|s| s["name"] == name).unwrap()["value"].clone();
    assert_eq!((value("read-dedup"), value("retention")), (serde_json::json!("false"), serde_json::Value::Null));

    let fails = |args: &[&str]| {
        let out = Command::new(env!("CARGO_BIN_EXE_timelake")).arg("-w").arg(&warehouse).args(args).output().unwrap();
        assert!(!out.status.success(), "{args:?} succeeded");
        String::from_utf8(out.stderr).unwrap()
    };
    assert!(fails(&["alter", "iot.r", "--set", "chunk-interval=hour"]).contains("fixed when the table is created"));
    assert!(fails(&["sql", "--set", "timelake.nope=1", "SELECT 1"]).contains("unknown setting"));
}

#[test]
fn upgrade_and_rollback() {
    let dir = tempfile::tempdir().unwrap();
    let warehouse = dir.path().join("warehouse");
    let csv = dir.path().join("r.csv");
    std::fs::write(&csv, "time,device,value\n2026-01-01T00:00:00Z,1,1.5\n").unwrap();
    let csv = csv.to_str().unwrap();
    let import = ["import", "iot.r", csv, "--time-column", "time", "--series-key", "device"];
    // A format 0.1.0 table, as Timelake 0.2 wrote them.
    timelake(&warehouse, &import);
    as_written_by_timelake_0_2(&warehouse.join("iot/r/metadata"));
    timelake(&warehouse, &["append", "iot.r", csv]);

    let (out, _) = timelake(&warehouse, &["upgrade", "--dry-run"]);
    assert!(out.contains("iot.r: would:") && out.contains("set table format 0.1.0 → 0.3.0"), "{out}");
    let (out, _) = timelake(&warehouse, &["upgrade", "iot.r"]);
    let undo = out.lines().find_map(|l| l.split("undo: ").nth(1)).unwrap_or_else(|| panic!("{out}"));
    let (out, _) = timelake(&warehouse, &["upgrade", "iot.r"]);
    assert!(out.contains("already current"), "{out}");

    let args: Vec<&str> = undo.split_whitespace().skip(1).collect(); // "timelake rollback iot.r <id>"
    let (out, _) = timelake(&warehouse, &args);
    assert!(out.contains("is current again"), "{out}");
}
