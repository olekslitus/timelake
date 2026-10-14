//! Iceberg table metadata (`vN.metadata.json`) and manifests (Avro), read without iceberg-rust so
//! the reader stays small and compiles to WebAssembly.

use std::collections::HashMap;

use apache_avro::types::Value;
use serde::{Deserialize, Serialize};
use timelake_format::bounds::{Bound, decode};
use timelake_format::{Contract, summary};

use crate::Error;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub id: i32,
    pub name: String,
    /// Iceberg type name for primitives (`long`, `timestamptz`, …); nested types are `"nested"`.
    #[serde(rename = "type")]
    pub ty: String,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub id: String,
    pub timestamp_ms: i64,
    pub operation: String,
    pub summary: HashMap<String, String>,
}

/// What a reader needs from the table metadata.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableMeta {
    pub location: String,
    pub format_version: u8,
    pub schema: Vec<Field>,
    pub properties: HashMap<String, String>,
    pub time_column: Option<String>,
    pub series_key: Vec<String>,
    pub chunk: Option<String>,
    pub dedup: bool,
    pub current_snapshot: Option<SnapshotInfo>,
    pub manifest_list: Option<String>,
    pub last_value_index: Option<String>,
    pub snapshot_count: usize,
    /// Newest first, at most 50.
    pub snapshots: Vec<SnapshotInfo>,
    pub last_updated_ms: i64,
}

#[derive(Deserialize)]
struct RawMeta {
    #[serde(rename = "format-version")]
    format_version: u8,
    location: String,
    #[serde(rename = "current-schema-id", default)]
    current_schema_id: i32,
    #[serde(default)]
    schemas: Vec<RawSchema>,
    #[serde(default)]
    properties: HashMap<String, String>,
    #[serde(rename = "current-snapshot-id")]
    current_snapshot_id: Option<i64>,
    #[serde(default)]
    snapshots: Vec<RawSnapshot>,
    #[serde(rename = "last-updated-ms", default)]
    last_updated_ms: i64,
}

#[derive(Deserialize)]
struct RawSchema {
    #[serde(rename = "schema-id", default)]
    schema_id: i32,
    fields: Vec<RawField>,
}

#[derive(Deserialize)]
struct RawField {
    id: i32,
    name: String,
    required: bool,
    #[serde(rename = "type")]
    ty: serde_json::Value,
}

#[derive(Deserialize)]
struct RawSnapshot {
    #[serde(rename = "snapshot-id")]
    snapshot_id: i64,
    #[serde(rename = "timestamp-ms")]
    timestamp_ms: i64,
    #[serde(rename = "manifest-list")]
    manifest_list: String,
    #[serde(default)]
    summary: HashMap<String, String>,
}

pub fn parse_table_metadata(json: &str) -> Result<TableMeta, Error> {
    let raw: RawMeta = serde_json::from_str(json).map_err(|e| Error(format!("bad table metadata: {e}")))?;
    let schema = raw
        .schemas
        .iter()
        .find(|s| s.schema_id == raw.current_schema_id)
        .or(raw.schemas.last())
        .ok_or_else(|| Error("table metadata has no schema".into()))?;
    let fields = schema
        .fields
        .iter()
        .map(|f| Field {
            id: f.id,
            name: f.name.clone(),
            ty: f.ty.as_str().map(str::to_string).unwrap_or_else(|| "nested".into()),
            required: f.required,
        })
        .collect();
    let contract = Contract::from_properties(&raw.properties).map_err(|e| Error(e.0))?;
    let current = raw.current_snapshot_id.and_then(|id| raw.snapshots.iter().find(|s| s.snapshot_id == id));
    let current_snapshot = current.map(|s| SnapshotInfo {
        id: s.snapshot_id.to_string(),
        timestamp_ms: s.timestamp_ms,
        operation: s.summary.get("operation").cloned().unwrap_or_default(),
        summary: s.summary.clone(),
    });
    Ok(TableMeta {
        location: raw.location,
        format_version: raw.format_version,
        schema: fields,
        time_column: contract.time_column.clone(),
        series_key: contract.series_key.clone(),
        chunk: contract.chunk.map(|c| c.as_str().to_string()),
        dedup: contract.dedup,
        properties: raw.properties,
        manifest_list: current.map(|s| s.manifest_list.clone()),
        last_value_index: current.and_then(|s| s.summary.get(summary::LAST_VALUE_INDEX).cloned()),
        current_snapshot,
        snapshot_count: raw.snapshots.len(),
        snapshots: {
            let mut v: Vec<SnapshotInfo> = raw
                .snapshots
                .iter()
                .map(|s| SnapshotInfo {
                    id: s.snapshot_id.to_string(),
                    timestamp_ms: s.timestamp_ms,
                    operation: s.summary.get("operation").cloned().unwrap_or_default(),
                    summary: s.summary.clone(),
                })
                .collect();
            v.sort_by_key(|s| std::cmp::Reverse(s.timestamp_ms));
            v.truncate(50);
            v
        },
        last_updated_ms: raw.last_updated_ms,
    })
}

// --- Avro ---------------------------------------------------------------------------------------

fn unwrap(v: &Value) -> &Value {
    match v {
        Value::Union(_, inner) => unwrap(inner),
        other => other,
    }
}

fn field<'a>(record: &'a Value, name: &str) -> Option<&'a Value> {
    match unwrap(record) {
        Value::Record(fields) => fields.iter().find(|(n, _)| n == name).map(|(_, v)| unwrap(v)),
        _ => None,
    }
}

fn as_i64(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Long(x) => Some(*x),
        Value::Int(x) => Some(*x as i64),
        _ => None,
    }
}

fn as_str(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

fn read_avro(bytes: &[u8]) -> Result<Vec<Value>, Error> {
    let reader = apache_avro::Reader::new(bytes).map_err(|e| Error(format!("bad Avro file: {e}")))?;
    reader.map(|v| v.map_err(|e| Error(format!("bad Avro record: {e}")))).collect()
}

/// One manifest of the current snapshot.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestRef {
    pub path: String,
    pub length: i64,
    /// 0 = data, 1 = deletes.
    pub content: i64,
    pub sequence_number: i64,
    pub added_snapshot_id: i64,
}

pub fn parse_manifest_list(bytes: &[u8]) -> Result<Vec<ManifestRef>, Error> {
    read_avro(bytes)?
        .iter()
        .map(|r| {
            Ok(ManifestRef {
                path: as_str(field(r, "manifest_path"))
                    .ok_or_else(|| Error("manifest list entry without path".into()))?,
                length: as_i64(field(r, "manifest_length")).unwrap_or(0),
                content: as_i64(field(r, "content")).unwrap_or(0),
                sequence_number: as_i64(field(r, "sequence_number")).unwrap_or(0),
                added_snapshot_id: as_i64(field(r, "added_snapshot_id")).unwrap_or(0),
            })
        })
        .collect()
}

/// A live data file with its statistics, keyed by column name.
#[derive(Debug, Clone)]
pub struct DataFile {
    pub path: String,
    pub size: u64,
    pub records: u64,
    pub partition: Option<i64>,
    pub lower: HashMap<String, Bound>,
    pub upper: HashMap<String, Bound>,
}

fn bounds(v: Option<&Value>, by_id: &HashMap<i32, &Field>) -> HashMap<String, Bound> {
    let mut out = HashMap::new();
    let entries = match v {
        Some(Value::Array(a)) => a.as_slice(),
        _ => return out,
    };
    for e in entries {
        let (Some(id), Some(Value::Bytes(b))) = (as_i64(field(e, "key")), field(e, "value")) else { continue };
        if let Some(f) = by_id.get(&(id as i32))
            && let Some(bound) = decode(&f.ty, b)
        {
            out.insert(f.name.clone(), bound);
        }
    }
    out
}

/// Live (not deleted) data files of one manifest.
pub fn parse_manifest(bytes: &[u8], schema: &[Field]) -> Result<Vec<DataFile>, Error> {
    let by_id: HashMap<i32, &Field> = schema.iter().map(|f| (f.id, f)).collect();
    let mut out = vec![];
    for entry in read_avro(bytes)? {
        if as_i64(field(&entry, "status")) == Some(2) {
            continue; // deleted
        }
        let Some(df) = field(&entry, "data_file") else { continue };
        if as_i64(field(df, "content")).unwrap_or(0) != 0 {
            continue; // delete files are not produced by Timelake v0
        }
        let partition = match field(df, "partition") {
            Some(Value::Record(fs)) => fs.first().and_then(|(_, v)| as_i64(Some(unwrap(v)))),
            _ => None,
        };
        out.push(DataFile {
            path: as_str(field(df, "file_path")).ok_or_else(|| Error("data file without path".into()))?,
            size: as_i64(field(df, "file_size_in_bytes")).unwrap_or(0) as u64,
            records: as_i64(field(df, "record_count")).unwrap_or(0) as u64,
            partition,
            lower: bounds(field(df, "lower_bounds"), &by_id),
            upper: bounds(field(df, "upper_bounds"), &by_id),
        });
    }
    Ok(out)
}
