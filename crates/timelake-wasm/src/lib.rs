//! Timelake reader for WebAssembly.
//!
//! The module does no I/O: the host (the `@timelake/client` TypeScript package) fetches objects
//! and byte ranges over HTTPS and hands them in. That keeps the WASM small, synchronous, and
//! identical in browsers, Node, and serverless functions.
//!
//! Flow for a query:
//! 1. `new Table(metadataJson)`; fetch `table.manifestList`, `table.addManifestList(bytes)` returns
//!    manifest paths; fetch each, `table.addManifest(bytes)`.
//! 2. `table.planFiles(query)` returns the data files whose bounds can match.
//! 3. Per file: fetch the tail, `new ParquetFile(size, tail)` (call `ParquetFile.footerLength`
//!    first if the tail might be short), `file.plan(query)` returns byte ranges, fetch them,
//!    `file.addRange(start, bytes)`, then `query.push(file)`.
//! 4. `query.finish()` returns the result as a JSON string.

mod meta;
mod query;

use wasm_bindgen::prelude::*;

pub use meta::{DataFile, TableMeta};
pub use query::{Aggregator, QuerySpec};

/// Error message carried to JavaScript as an `Error`.
#[derive(Debug)]
pub struct Error(pub String);

impl From<Error> for JsValue {
    fn from(e: Error) -> JsValue {
        js_sys::Error::new(&e.0).into()
    }
}

fn spec_from(js: JsValue) -> Result<QuerySpec, JsValue> {
    serde_wasm_bindgen::from_value(js).map_err(|e| Error(format!("bad query: {e}")).into())
}

fn to_js<T: serde::Serialize>(v: &T) -> Result<JsValue, JsValue> {
    v.serialize(&serde_wasm_bindgen::Serializer::json_compatible()).map_err(|e| Error(e.to_string()).into())
}

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").into()
}

/// A table at one version: its metadata plus the data files of the current snapshot.
#[wasm_bindgen]
pub struct Table {
    meta: TableMeta,
    files: Vec<DataFile>,
}

#[wasm_bindgen]
impl Table {
    #[wasm_bindgen(constructor)]
    pub fn new(metadata_json: &str) -> Result<Table, JsValue> {
        Ok(Table { meta: meta::parse_table_metadata(metadata_json)?, files: vec![] })
    }

    /// Contract, schema and snapshot summary (a plain object).
    pub fn info(&self) -> Result<JsValue, JsValue> {
        to_js(&self.meta)
    }

    #[wasm_bindgen(getter, js_name = manifestList)]
    pub fn manifest_list(&self) -> Option<String> {
        self.meta.manifest_list.clone()
    }

    #[wasm_bindgen(getter, js_name = lastValueIndex)]
    pub fn last_value_index(&self) -> Option<String> {
        self.meta.last_value_index.clone()
    }

    /// Parses the manifest list; returns the paths of the data manifests to fetch.
    #[wasm_bindgen(js_name = addManifestList)]
    pub fn add_manifest_list(&mut self, bytes: &[u8]) -> Result<Vec<String>, JsValue> {
        Ok(meta::parse_manifest_list(bytes)?.into_iter().filter(|m| m.content == 0).map(|m| m.path).collect())
    }

    #[wasm_bindgen(js_name = addManifest)]
    pub fn add_manifest(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
        self.files.extend(meta::parse_manifest(bytes, &self.meta.schema)?);
        Ok(())
    }

    /// All live data files: `[{path, size, records, partition}]`.
    pub fn files(&self) -> Result<JsValue, JsValue> {
        let v: Vec<serde_json::Value> = self
            .files
            .iter()
            .map(|f| serde_json::json!({ "path": f.path, "size": f.size, "records": f.records, "partition": f.partition }))
            .collect();
        to_js(&v)
    }

    /// Data files that may contain rows matching `query`: `[{path, size, records}]`.
    #[wasm_bindgen(js_name = planFiles)]
    pub fn plan_files(&self, query: JsValue) -> Result<JsValue, JsValue> {
        let spec = spec_from(query)?;
        let v: Vec<serde_json::Value> = query::plan_files(&self.files, &spec)
            .into_iter()
            .map(|f| serde_json::json!({ "path": f.path, "size": f.size, "records": f.records }))
            .collect();
        to_js(&v)
    }
}

/// One Parquet file being read through fetched byte ranges.
#[wasm_bindgen]
pub struct ParquetFile {
    inner: query::OpenFile,
}

#[wasm_bindgen]
impl ParquetFile {
    /// Bytes needed from the end of the file for the footer, given at least its last 8 bytes.
    #[wasm_bindgen(js_name = footerLength)]
    pub fn footer_length(tail: &[u8]) -> Result<f64, JsValue> {
        Ok(query::footer_len(tail)? as f64)
    }

    /// `tail` must contain the whole footer (the last `footerLength` bytes or more).
    #[wasm_bindgen(constructor)]
    pub fn new(size: f64, tail: Vec<u8>) -> Result<ParquetFile, JsValue> {
        Ok(ParquetFile { inner: query::OpenFile::new(size as u64, tail)? })
    }

    /// Selects row groups and columns for `query`; returns `[[start, end), …]` byte ranges to fetch.
    pub fn plan(&mut self, query: JsValue) -> Result<JsValue, JsValue> {
        let spec = spec_from(query)?;
        let ranges: Vec<[f64; 2]> = self.inner.plan(&spec).into_iter().map(|(s, e)| [s as f64, e as f64]).collect();
        to_js(&ranges)
    }

    #[wasm_bindgen(js_name = addRange)]
    pub fn add_range(&mut self, start: f64, bytes: Vec<u8>) {
        self.inner.add_range(start as u64, bytes);
    }
}

/// Accumulates results across files: rows, or time-bucket aggregates when `query.bucket` is set.
#[wasm_bindgen]
pub struct Query {
    spec: QuerySpec,
    rows: Vec<arrow_array::RecordBatch>,
    agg: Option<Aggregator>,
}

#[wasm_bindgen]
impl Query {
    #[wasm_bindgen(constructor)]
    pub fn new(query: JsValue) -> Result<Query, JsValue> {
        let spec = spec_from(query)?;
        let agg = match &spec.bucket {
            Some(b) => {
                let tc = spec.time_column.clone().ok_or_else(|| Error("bucket queries need a time column".into()))?;
                Some(Aggregator::new(b.clone(), tc)?)
            }
            None => None,
        };
        Ok(Query { spec, rows: vec![], agg })
    }

    /// Decodes the file's planned ranges and adds matching rows to the result.
    pub fn push(&mut self, file: &ParquetFile) -> Result<(), JsValue> {
        for b in file.inner.read(&self.spec)? {
            match &mut self.agg {
                Some(a) => a.push(&b)?,
                None => self.rows.push(b),
            }
        }
        Ok(())
    }

    /// The result as a JSON array string.
    pub fn finish(&self) -> Result<String, JsValue> {
        match &self.agg {
            Some(a) => Ok(a.finish()),
            None => Ok(query::rows_json(&self.rows, &self.spec)?),
        }
    }
}
