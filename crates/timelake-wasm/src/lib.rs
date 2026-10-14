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
//!
//! The same steps are available to Rust through [`TableMeta`], [`plan_files`], [`FileReader`] and
//! [`Collector`].

mod aggregate;
mod error;
mod file;
mod filter;
mod keys;
mod latest;
mod meta;
mod output;
mod prune;
mod query;
mod spec;

use serde::Serialize;
use wasm_bindgen::prelude::*;

pub use aggregate::bucket_start;
pub use error::{Error, Result};
pub use file::{COALESCE_GAP, FileReader, coalesce, footer_len};
pub use meta::{
    DataFile, Field, MAX_SNAPSHOTS, ManifestContent, ManifestRef, SnapshotInfo, TableMeta, parse_manifest,
    parse_manifest_list,
};
pub use prune::plan_files;
pub use query::Collector;
pub use spec::{AggInput, AggOp, AggSpec, BucketSpec, QuerySpec};

impl From<Error> for JsValue {
    fn from(e: Error) -> Self {
        js_sys::Error::new(&e.to_string()).into()
    }
}

fn parse_query(query: &JsValue) -> Result<QuerySpec> {
    serde_wasm_bindgen::from_value(query.clone()).map_err(|e| Error::invalid(format!("bad query: {e}")))
}

fn to_js<T: Serialize + ?Sized>(value: &T) -> Result<JsValue, JsValue> {
    Ok(value.serialize(&serde_wasm_bindgen::Serializer::json_compatible())?)
}

/// A byte offset or size passed as a JavaScript number.
fn byte_offset(x: f64) -> Result<u64> {
    const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
    if !(0.0..=MAX_SAFE_INTEGER).contains(&x) || x.fract() != 0.0 {
        return Err(Error::invalid(format!("not a byte offset: {x}")));
    }
    #[expect(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "a safe integer, checked above")]
    Ok(x as u64)
}

/// Version of this crate.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").into()
}

/// A data file as JavaScript sees it.
#[derive(Serialize)]
struct FileView<'a> {
    path: &'a str,
    size: u64,
    records: u64,
    partition: Option<i64>,
}

impl<'a> From<&'a DataFile> for FileView<'a> {
    fn from(f: &'a DataFile) -> Self {
        Self { path: &f.path, size: f.size, records: f.records, partition: f.partition }
    }
}

/// A table at one version: its metadata plus the data files of the current snapshot.
#[wasm_bindgen]
#[derive(Debug)]
pub struct Table {
    meta: TableMeta,
    files: Vec<DataFile>,
}

#[wasm_bindgen]
impl Table {
    #[wasm_bindgen(constructor)]
    pub fn new(metadata_json: &str) -> Result<Table, JsValue> {
        Ok(Table { meta: TableMeta::parse(metadata_json)?, files: vec![] })
    }

    /// Contract, schema and snapshot summary (a plain object).
    pub fn info(&self) -> Result<JsValue, JsValue> {
        to_js(&self.meta)
    }

    /// The current snapshot's manifest list, if the table has a snapshot.
    #[wasm_bindgen(getter, js_name = manifestList)]
    pub fn manifest_list(&self) -> Option<String> {
        self.meta.manifest_list.clone()
    }

    /// The current snapshot's last-value index (newest row per series), if it has one.
    #[wasm_bindgen(getter, js_name = lastValueIndex)]
    pub fn last_value_index(&self) -> Option<String> {
        self.meta.last_value_index.clone()
    }

    /// Parses the manifest list; returns the paths of the data manifests to fetch and add.
    #[wasm_bindgen(js_name = addManifestList)]
    pub fn add_manifest_list(&self, bytes: &[u8]) -> Result<Vec<String>, JsValue> {
        let manifests = parse_manifest_list(bytes)?;
        Ok(manifests.into_iter().filter(|m| m.content == ManifestContent::Data).map(|m| m.path).collect())
    }

    /// Adds the live data files of one data manifest.
    #[wasm_bindgen(js_name = addManifest)]
    pub fn add_manifest(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
        self.files.extend(parse_manifest(bytes, &self.meta.schema)?);
        Ok(())
    }

    /// All live data files: `[{path, size, records, partition}]`.
    pub fn files(&self) -> Result<JsValue, JsValue> {
        to_js(&self.files.iter().map(FileView::from).collect::<Vec<_>>())
    }

    /// Data files that may contain rows matching `query`, in the same shape as `files()`.
    #[wasm_bindgen(js_name = planFiles)]
    pub fn plan_files(&self, query: &JsValue) -> Result<JsValue, JsValue> {
        let files = prune::plan_files(&self.files, &parse_query(query)?);
        to_js(&files.into_iter().map(FileView::from).collect::<Vec<_>>())
    }
}

/// One Parquet file, read through the byte ranges the host fetches.
#[wasm_bindgen]
#[derive(Debug)]
pub struct ParquetFile {
    reader: FileReader,
}

#[wasm_bindgen]
impl ParquetFile {
    /// Bytes needed from the end of the file for the footer, given at least its last 8 bytes.
    #[wasm_bindgen(js_name = footerLength)]
    pub fn footer_length(tail: &[u8]) -> Result<f64, JsValue> {
        Ok(footer_len(tail)? as f64)
    }

    /// `tail` must contain the whole footer (the last `footerLength` bytes or more).
    #[wasm_bindgen(constructor)]
    pub fn new(size: f64, tail: &[u8]) -> Result<ParquetFile, JsValue> {
        Ok(ParquetFile { reader: FileReader::new(byte_offset(size)?, tail)? })
    }

    /// Selects row groups and columns for `query`; returns the byte ranges to fetch,
    /// `[[start, end), …]`.
    pub fn plan(&mut self, query: &JsValue) -> Result<JsValue, JsValue> {
        let ranges = self.reader.plan(&parse_query(query)?);
        to_js(&ranges.into_iter().map(|r| [r.start as f64, r.end as f64]).collect::<Vec<_>>())
    }

    /// Adds fetched bytes starting at offset `start`.
    #[wasm_bindgen(js_name = addRange)]
    pub fn add_range(&mut self, start: f64, bytes: Vec<u8>) -> Result<(), JsValue> {
        self.reader.add_range(byte_offset(start)?, bytes);
        Ok(())
    }
}

/// Collects a query's result across files: rows, time-bucket aggregates when `query.bucket` is
/// set, or the newest row per series when `query.latestBy` is.
#[wasm_bindgen]
#[derive(Debug)]
pub struct Query {
    collector: Collector,
}

#[wasm_bindgen]
impl Query {
    #[wasm_bindgen(constructor)]
    pub fn new(query: &JsValue) -> Result<Query, JsValue> {
        Ok(Query { collector: Collector::new(parse_query(query)?)? })
    }

    /// Decodes the file's planned ranges and adds its matching rows to the result.
    pub fn push(&mut self, file: &ParquetFile) -> Result<(), JsValue> {
        Ok(self.collector.push(&file.reader)?)
    }

    /// The result as a JSON array string.
    pub fn finish(&self) -> Result<String, JsValue> {
        Ok(self.collector.finish()?)
    }
}
