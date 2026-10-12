//! `Lake` (a warehouse location) and `Table` handles, plus the object-store-only catalog.
//!
//! Catalog layout (Hadoop-catalog compatible, so DuckDB `iceberg_scan('<table dir>')` and Spark's
//! HadoopCatalog can read it):
//!
//! ```text
//! <warehouse>/<namespace>/<table>/metadata/v<N>.metadata.json   committed with put-if-absent
//! <warehouse>/<namespace>/<table>/metadata/version-hint.text    "<N>", best-effort pointer
//! <warehouse>/<namespace>/<table>/data/<partition>/<file>.parquet
//! ```
//!
//! A commit is "create `v<N+1>.metadata.json` if it doesn't exist". Exactly one writer wins; the
//! others get [`Error::Conflict`] and rebase. No database or catalog server is involved.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use arrow::datatypes::{DataType, Field, Schema as ArrowSchema, SchemaRef, TimeUnit};
use bytes::Bytes;
use iceberg::arrow::{arrow_schema_to_schema_auto_assign_ids, schema_to_arrow_schema};
use iceberg::spec::{
    DataFile, FormatVersion, Manifest, ManifestFile, ManifestList, ManifestStatus, NullOrder,
    SortDirection, SortField, SortOrder, TableMetadata, TableMetadataBuilder, Transform,
    UnboundPartitionSpec,
};
use iceberg::TableCreation;

use crate::contract::*;
use crate::error::{Error, Result};
use crate::storage::{Storage, warehouse_url};

pub const DEFAULT_NAMESPACE: &str = "default";
pub use timelake_format::{S_BATCH_ID, S_LVI};

/// A warehouse: a root location holding namespaces and tables.
#[derive(Clone)]
pub struct Lake {
    pub(crate) inner: Arc<LakeInner>,
}

pub(crate) struct LakeInner {
    pub storage: Storage,
    pub root: String,
    /// Manifest lists and manifests are immutable, so they are cached by path.
    manifest_lists: Mutex<HashMap<String, Arc<Vec<ManifestFile>>>>,
    manifests: Mutex<HashMap<String, Arc<Vec<LiveEntry>>>>,
    /// Last-value indexes this process wrote or read (small, immutable).
    lvis: Mutex<HashMap<String, arrow::array::RecordBatch>>,
    /// Recently loaded or committed table versions, for read planning (see `table_recent`).
    recent: Mutex<HashMap<TableName, (std::time::Instant, Table)>>,
}

/// A table name: `namespace.table`, or just `table` in the `default` namespace.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct TableName {
    pub namespace: String,
    pub name: String,
}

impl TableName {
    pub fn parse(s: &str) -> Result<Self> {
        let valid = |p: &str| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        let (ns, name) = match s.split_once('.') {
            Some((ns, name)) => (ns, name),
            None => (DEFAULT_NAMESPACE, s),
        };
        if !valid(ns) || !valid(name) {
            return Err(Error::invalid(format!("table name {s:?} must be [namespace.]table using [A-Za-z0-9_-]")));
        }
        Ok(Self { namespace: ns.to_string(), name: name.to_string() })
    }
}

impl std::fmt::Display for TableName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}", self.namespace, self.name)
    }
}

/// A live (or, transiently, deleted) manifest entry with inherited sequence numbers resolved.
#[derive(Clone, Debug)]
pub struct LiveEntry {
    pub status: ManifestStatus,
    pub data_file: DataFile,
    pub snapshot_id: i64,
    pub sequence_number: i64,
    pub file_sequence_number: i64,
}

impl Lake {
    /// Opens (or initializes) a warehouse. `location` is a URL (`s3://bucket/prefix`, `gs://…`,
    /// `file:///…`) or a local path.
    pub fn open(location: &str, options: HashMap<String, String>) -> Result<Self> {
        let url = warehouse_url(location)?;
        let storage = Storage::open(&url, &options)?;
        let root = url.as_str().trim_end_matches('/').to_string();
        Ok(Self {
            inner: Arc::new(LakeInner {
                storage,
                root,
                manifest_lists: Mutex::default(),
                manifests: Mutex::default(),
                lvis: Mutex::default(),
                recent: Mutex::default(),
            }),
        })
    }

    pub fn storage(&self) -> &Storage {
        &self.inner.storage
    }

    pub fn location(&self) -> &str {
        &self.inner.root
    }

    pub fn table_location(&self, name: &TableName) -> String {
        format!("{}/{}/{}", self.inner.root, name.namespace, name.name)
    }

    pub async fn namespaces(&self) -> Result<Vec<String>> {
        if !self.inner.storage.can_list() {
            let mut v: Vec<String> = self.indexed_tables().await?.into_iter().map(|t| t.namespace).collect();
            v.sort();
            v.dedup();
            return Ok(v);
        }
        let mut v = self.inner.storage.list_dirs(&self.inner.root).await?;
        v.sort();
        Ok(v)
    }

    /// Tables recorded in the warehouse's `timelake-tables.json` index.
    async fn indexed_tables(&self) -> Result<Vec<TableName>> {
        let uri = format!("{}/{}", self.inner.root, timelake_format::TABLES_INDEX);
        let Some(bytes) = self.inner.storage.read_opt(&uri).await? else { return Ok(vec![]) };
        let names: Vec<String> = serde_json::from_slice(&bytes)?;
        names.iter().map(|n| TableName::parse(n)).collect()
    }

    /// Rewrites `timelake-tables.json`, the table index used by readers that cannot list (HTTPS,
    /// browsers). Called on create and drop; run it explicitly after copying tables around.
    pub async fn write_tables_index(&self) -> Result<Vec<String>> {
        let names: Vec<String> = self.all_tables().await?.into_iter().map(|t| t.to_string()).collect();
        let uri = format!("{}/{}", self.inner.root, timelake_format::TABLES_INDEX);
        self.inner.storage.write(&uri, Bytes::from(serde_json::to_vec_pretty(&names)?)).await?;
        Ok(names)
    }

    /// Tables in a namespace (directories that contain `metadata/version-hint.text`).
    pub async fn tables(&self, namespace: &str) -> Result<Vec<TableName>> {
        if !self.inner.storage.can_list() {
            return Ok(self.indexed_tables().await?.into_iter().filter(|t| t.namespace == namespace).collect());
        }
        let dirs = self.inner.storage.list_dirs(&format!("{}/{namespace}", self.inner.root)).await?;
        let mut out = vec![];
        for d in dirs {
            let name = TableName { namespace: namespace.to_string(), name: d };
            if self.inner.storage.exists(&hint_uri(&self.table_location(&name))).await? {
                out.push(name);
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    pub async fn all_tables(&self) -> Result<Vec<TableName>> {
        let mut out = vec![];
        for ns in self.namespaces().await? {
            out.extend(self.tables(&ns).await?);
        }
        Ok(out)
    }

    /// Creates a table from an Arrow schema. Arrow types are normalized to what Iceberg supports
    /// (e.g. any timestamp → microseconds, small ints → int, dictionaries → their value type).
    pub async fn create_table(&self, name: &str, schema: &ArrowSchema, opts: TableOptions) -> Result<Table> {
        let name = TableName::parse(name)?;
        let location = self.table_location(&name);
        if self.inner.storage.exists(&hint_uri(&location)).await? {
            return Err(Error::AlreadyExists(name.to_string()));
        }
        let normalized = normalize_schema(schema, opts.time_column.as_deref())?;
        let ice_schema = arrow_schema_to_schema_auto_assign_ids(&normalized)?;

        let mut props: HashMap<String, String> = HashMap::from([
            ("write.format.default".into(), "parquet".into()),
            ("write.parquet.compression-codec".into(), "zstd".into()),
            // Keep metadata.json small: it is read by every query.
            ("write.metadata.previous-versions-max".into(), "20".into()),
        ]);
        let mut creation = TableCreation::builder()
            .name(name.name.clone())
            .location(location.clone())
            .schema(ice_schema.clone())
            .format_version(FormatVersion::V2)
            .build();

        if let Some(tc) = &opts.time_column {
            let field = ice_schema
                .field_by_name(tc)
                .ok_or_else(|| Error::invalid(format!("time column {tc:?} is not in the schema")))?;
            match normalized.field_with_name(tc)?.data_type() {
                DataType::Timestamp(_, _) => {}
                other => return Err(Error::invalid(format!("time column {tc:?} must be a timestamp, got {other}"))),
            }
            for k in &opts.series_key {
                if ice_schema.field_by_name(k).is_none() {
                    return Err(Error::invalid(format!("series key column {k:?} is not in the schema")));
                }
            }
            let chunk = opts.chunk.unwrap_or(Chunk::Day);
            let transform = match chunk {
                Chunk::Hour => Transform::Hour,
                Chunk::Day => Transform::Day,
                Chunk::Month => Transform::Month,
            };
            creation.partition_spec = Some(
                UnboundPartitionSpec::builder()
                    .add_partition_field(field.id, format!("{tc}_{}", chunk.as_str()), transform)?
                    .build(),
            );
            let mut order = SortOrder::builder();
            order.with_order_id(1);
            for col in opts.series_key.iter().chain(std::iter::once(tc)) {
                order.with_sort_field(SortField {
                    source_id: ice_schema.field_by_name(col).unwrap().id,
                    transform: Transform::Identity,
                    direction: SortDirection::Ascending,
                    null_order: NullOrder::First,
                });
            }
            creation.sort_order = Some(order.build(&ice_schema)?);
            props.insert(P_TIME_COLUMN.into(), tc.clone());
            props.insert(P_CHUNK.into(), chunk.as_str().into());
            if !opts.series_key.is_empty() {
                props.insert(P_SERIES_KEY.into(), opts.series_key.join(","));
            }
            // Dedup defaults on when rows have an identity (series key + time).
            props.insert(P_DEDUP.into(), opts.dedup.unwrap_or(!opts.series_key.is_empty()).to_string());
        } else if !opts.series_key.is_empty() {
            return Err(Error::invalid("series_key requires a time_column"));
        }
        if let Some(r) = &opts.retention {
            parse_duration(r)?;
            props.insert(P_RETENTION.into(), r.clone());
        }
        props.extend(opts.properties.clone());
        Contract::from_properties(&props)?; // validate
        creation.properties = props;

        let metadata = TableMetadataBuilder::from_table_creation(creation)?.build()?.metadata;
        let st = &self.inner.storage;
        if !st.write_if_absent(&metadata_uri(&location, 1), Bytes::from(serde_json::to_vec(&metadata)?)).await? {
            return Err(Error::AlreadyExists(name.to_string()));
        }
        st.write(&hint_uri(&location), Bytes::from("1")).await?;
        let t = Table::new(self.clone(), name, location, 1, metadata)?;
        if st.can_list() {
            let _ = self.write_tables_index().await;
        }
        Ok(t)
    }

    /// Loads the current version of a table.
    pub async fn table(&self, name: &str) -> Result<Table> {
        let name = TableName::parse(name)?;
        let location = self.table_location(&name);
        let st = &self.inner.storage;
        let hint = st.read_opt(&hint_uri(&location)).await?.ok_or_else(|| Error::NotFound(name.to_string()))?;
        let mut version: u64 = std::str::from_utf8(&hint)
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .ok_or_else(|| Error::invalid(format!("bad version hint for {name}")))?;
        // The hint is updated after the commit, so it may lag: probe forward while fetching.
        loop {
            let (cur_uri, next_uri) = (metadata_uri(&location, version), metadata_uri(&location, version + 1));
            let (cur, next) = tokio::join!(st.read_opt(&cur_uri), st.exists(&next_uri));
            if next? {
                version += 1;
                continue;
            }
            let bytes = cur?.ok_or_else(|| Error::NotFound(format!("{name} metadata v{version}")))?;
            let metadata: TableMetadata = serde_json::from_slice(&bytes)?;
            let t = Table::new(self.clone(), name, location, version, metadata)?;
            self.remember(&t);
            return Ok(t);
        }
    }

    /// Like [`Lake::table`], but reuses a version loaded or committed by this process within
    /// `max_age`. Query planning uses it so one query loads each table once, and so prefetching
    /// all of a query's tables concurrently pays off.
    pub async fn table_recent(&self, name: &str, max_age: std::time::Duration) -> Result<Table> {
        let parsed = TableName::parse(name)?;
        if let Some((at, t)) = self.inner.recent.lock().unwrap().get(&parsed)
            && at.elapsed() <= max_age
        {
            return Ok(t.clone());
        }
        self.table(name).await
    }

    pub(crate) fn remember(&self, t: &Table) {
        let mut r = self.inner.recent.lock().unwrap();
        let newer = r.get(&t.name).is_none_or(|(_, old)| old.version <= t.version);
        if newer {
            r.insert(t.name.clone(), (std::time::Instant::now(), t.clone()));
        }
    }

    pub async fn drop_table(&self, name: &str) -> Result<()> {
        self.inner.recent.lock().unwrap().remove(&TableName::parse(name)?);
        let name = TableName::parse(name)?;
        let location = self.table_location(&name);
        let uris = self.inner.storage.list(&location).await?.into_iter().map(|(u, _, _)| u).collect();
        self.inner.storage.delete_many(uris).await?;
        let _ = self.write_tables_index().await;
        Ok(())
    }

    pub(crate) async fn manifest_list(&self, uri: &str, version: FormatVersion) -> Result<Arc<Vec<ManifestFile>>> {
        if let Some(v) = self.inner.manifest_lists.lock().unwrap().get(uri) {
            return Ok(v.clone());
        }
        let bytes = self.inner.storage.read(uri).await?;
        let list = Arc::new(ManifestList::parse_with_version(&bytes, version)?.consume_entries().into_iter().collect::<Vec<_>>());
        let mut cache = self.inner.manifest_lists.lock().unwrap();
        if cache.len() > 1024 {
            cache.clear();
        }
        cache.insert(uri.to_string(), list.clone());
        Ok(list)
    }

    /// Entries of one manifest with inherited snapshot ids and sequence numbers filled in.
    pub(crate) async fn manifest(&self, mf: &ManifestFile) -> Result<Arc<Vec<LiveEntry>>> {
        if let Some(v) = self.inner.manifests.lock().unwrap().get(&mf.manifest_path) {
            return Ok(v.clone());
        }
        let bytes = self.inner.storage.read(&mf.manifest_path).await?;
        let (entries, _meta) = Manifest::parse_avro(&bytes)?.into_parts();
        let entries = Arc::new(
            entries
                .iter()
                .map(|e| {
                    let added = e.status == ManifestStatus::Added;
                    let inherit = |v: Option<i64>| v.or(added.then_some(mf.sequence_number));
                    LiveEntry {
                        status: e.status,
                        data_file: e.data_file.clone(),
                        snapshot_id: e.snapshot_id.unwrap_or(mf.added_snapshot_id),
                        sequence_number: inherit(e.sequence_number).unwrap_or(0),
                        file_sequence_number: inherit(e.file_sequence_number).unwrap_or(0),
                    }
                })
                .collect::<Vec<_>>(),
        );
        let mut cache = self.inner.manifests.lock().unwrap();
        if cache.len() > 8192 {
            cache.clear();
        }
        cache.insert(mf.manifest_path.clone(), entries.clone());
        Ok(entries)
    }
}

impl Lake {
    pub(crate) fn cache_manifest(&self, path: String, entries: Vec<LiveEntry>) {
        let mut c = self.inner.manifests.lock().unwrap();
        if c.len() > 8192 {
            c.clear();
        }
        c.insert(path, Arc::new(entries));
    }

    pub(crate) fn cache_manifest_list(&self, path: String, list: Vec<ManifestFile>) {
        let mut c = self.inner.manifest_lists.lock().unwrap();
        if c.len() > 1024 {
            c.clear();
        }
        c.insert(path, Arc::new(list));
    }

    pub(crate) fn cache_lvi(&self, path: String, batch: arrow::array::RecordBatch) {
        let mut c = self.inner.lvis.lock().unwrap();
        if c.len() > 64 {
            c.clear();
        }
        c.insert(path, batch);
    }

    pub(crate) fn cached_lvi(&self, path: &str) -> Option<arrow::array::RecordBatch> {
        self.inner.lvis.lock().unwrap().get(path).cloned()
    }
}

pub(crate) fn metadata_uri(location: &str, version: u64) -> String {
    format!("{location}/metadata/v{version}.metadata.json")
}

pub(crate) fn hint_uri(location: &str) -> String {
    format!("{location}/metadata/version-hint.text")
}

/// A table at one committed version. Cheap to clone; call [`Table::refresh`] to see newer commits.
#[derive(Clone)]
pub struct Table {
    pub(crate) lake: Lake,
    pub name: TableName,
    pub location: String,
    pub version: u64,
    pub metadata: Arc<TableMetadata>,
    pub contract: Contract,
    arrow_schema: SchemaRef,
}

impl Table {
    pub(crate) fn new(lake: Lake, name: TableName, location: String, version: u64, metadata: TableMetadata) -> Result<Self> {
        let contract = Contract::from_properties(metadata.properties())?;
        let arrow_schema = Arc::new(schema_to_arrow_schema(metadata.current_schema())?);
        Ok(Self { lake, name, location, version, metadata: Arc::new(metadata), contract, arrow_schema })
    }

    pub fn lake(&self) -> &Lake {
        &self.lake
    }

    /// Arrow schema of the table (fields carry Iceberg field ids as `PARQUET:field_id` metadata).
    pub fn schema(&self) -> SchemaRef {
        self.arrow_schema.clone()
    }

    pub async fn refresh(&self) -> Result<Table> {
        self.lake.table(&self.name.to_string()).await
    }

    pub fn current_snapshot(&self) -> Option<&iceberg::spec::SnapshotRef> {
        self.metadata.current_snapshot()
    }

    /// Location of the last-value index for the current snapshot, if the table has one.
    pub fn last_value_index(&self) -> Option<String> {
        self.current_snapshot()?.summary().additional_properties.get(S_LVI).cloned()
    }

    /// Manifests of the current snapshot.
    pub async fn manifests(&self) -> Result<Arc<Vec<ManifestFile>>> {
        match self.current_snapshot() {
            None => Ok(Arc::new(vec![])),
            Some(s) => self.lake.manifest_list(s.manifest_list(), self.metadata.format_version()).await,
        }
    }

    /// All live data files of the current snapshot.
    pub async fn files(&self) -> Result<Vec<LiveEntry>> {
        let manifests = self.manifests().await?;
        let loaded = futures::future::try_join_all(manifests.iter().map(|m| self.lake.manifest(m))).await?;
        Ok(loaded
            .iter()
            .flat_map(|es| es.iter().filter(|e| e.status != ManifestStatus::Deleted).cloned())
            .collect())
    }
}

/// Maps Arrow types to ones with a lossless Iceberg equivalent.
pub(crate) fn normalize_schema(schema: &ArrowSchema, time_column: Option<&str>) -> Result<ArrowSchema> {
    fn norm(dt: &DataType) -> Result<DataType> {
        Ok(match dt {
            DataType::Int8 | DataType::Int16 | DataType::UInt8 | DataType::UInt16 => DataType::Int32,
            DataType::UInt32 => DataType::Int64,
            DataType::Float16 => DataType::Float32,
            DataType::Timestamp(_, tz) => DataType::Timestamp(TimeUnit::Microsecond, tz.as_ref().map(|_| "+00:00".into())),
            DataType::Date64 => DataType::Date32,
            DataType::Dictionary(_, v) => norm(v)?,
            DataType::LargeUtf8 | DataType::Utf8View => DataType::Utf8,
            DataType::LargeBinary | DataType::BinaryView => DataType::Binary,
            DataType::UInt64 => return Err(Error::invalid("UInt64 columns are not supported by Iceberg; cast to Int64")),
            other => other.clone(),
        })
    }
    let fields = schema
        .fields()
        .iter()
        .map(|f| {
            // The time column is NOT NULL: every row must have a time.
            let is_time = Some(f.name().as_str()) == time_column;
            let mut dt = norm(f.data_type())?;
            // Times given as text (CSV, JSON) are parsed as UTC timestamps on write.
            if is_time && matches!(dt, DataType::Utf8) {
                dt = DataType::Timestamp(TimeUnit::Microsecond, Some("+00:00".into()));
            }
            Ok(Field::new(f.name(), dt, f.is_nullable() && !is_time))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(ArrowSchema::new(fields))
}
