use std::fmt;
use std::sync::Arc;

use arrow::datatypes::SchemaRef;
use iceberg::arrow::schema_to_arrow_schema;
use iceberg::spec::{DataFile, ManifestFile, ManifestStatus, SnapshotRef, TableMetadata};

use crate::contract::Contract;
use crate::error::Result;
use crate::lake::Lake;
use crate::name::TableName;
use crate::summary;

/// A table at one committed version. Cheap to clone; call [`Table::refresh`] to see newer commits.
///
/// Operations that commit ([`Table::append`], [`Table::maintain`]) return the new version and
/// leave `self` unchanged.
#[derive(Clone)]
pub struct Table {
    lake: Lake,
    name: TableName,
    location: String,
    version: u64,
    metadata: Arc<TableMetadata>,
    contract: Contract,
    schema: SchemaRef,
}

/// A manifest entry of a data file, with inherited snapshot id and sequence numbers resolved.
#[derive(Clone, Debug)]
pub struct LiveEntry {
    /// `Added` or `Existing` for live files; `Deleted` entries only record a removal.
    pub status: ManifestStatus,
    /// The data file (shared: entries are cloned on every scan plan).
    pub data_file: Arc<DataFile>,
    /// The snapshot that added the file.
    pub snapshot_id: i64,
    /// Data sequence number: orders the file's rows against other files' rows.
    pub sequence_number: i64,
    /// Sequence number of the commit that added the file.
    pub file_sequence_number: i64,
}

impl Table {
    pub(crate) fn new(
        lake: Lake,
        name: TableName,
        location: String,
        version: u64,
        metadata: TableMetadata,
    ) -> Result<Self> {
        let contract = Contract::from_properties(metadata.properties())?;
        let schema = Arc::new(schema_to_arrow_schema(metadata.current_schema())?);
        Ok(Self { lake, name, location, version, metadata: Arc::new(metadata), contract, schema })
    }

    /// The lake this table belongs to.
    pub fn lake(&self) -> &Lake {
        &self.lake
    }

    /// The table's name.
    pub fn name(&self) -> &TableName {
        &self.name
    }

    /// The table's root URI (`<warehouse>/<namespace>/<table>`).
    pub fn location(&self) -> &str {
        &self.location
    }

    /// The metadata version (`v<N>.metadata.json`) this handle reads.
    pub fn version(&self) -> u64 {
        self.version
    }

    /// The Iceberg metadata of this version.
    pub fn metadata(&self) -> &TableMetadata {
        &self.metadata
    }

    /// The Timelake contract (time column, series key, layout and maintenance policy).
    pub fn contract(&self) -> &Contract {
        &self.contract
    }

    /// Arrow schema of the table (fields carry Iceberg field ids as `PARQUET:field_id` metadata).
    pub fn schema(&self) -> SchemaRef {
        self.schema.clone()
    }

    /// Loads the latest committed version.
    pub async fn refresh(&self) -> Result<Table> {
        self.lake.load(&self.name).await
    }

    /// The current snapshot, if anything was ever committed.
    pub fn current_snapshot(&self) -> Option<&SnapshotRef> {
        self.metadata.current_snapshot()
    }

    /// A value from the current snapshot's summary.
    pub(crate) fn summary_value(&self, key: &str) -> Option<&str> {
        self.current_snapshot()?.summary().additional_properties.get(key).map(String::as_str)
    }

    /// Location of the last-value index for the current snapshot, if the table has one.
    pub fn last_value_index(&self) -> Option<String> {
        self.summary_value(summary::LAST_VALUE_INDEX).map(str::to_string)
    }

    /// Manifests of the current snapshot.
    pub async fn manifests(&self) -> Result<Arc<Vec<ManifestFile>>> {
        match self.current_snapshot() {
            None => Ok(Arc::default()),
            Some(s) => self.lake.manifest_list(s.manifest_list(), self.metadata.format_version()).await,
        }
    }

    /// All live data files of the current snapshot.
    pub async fn files(&self) -> Result<Vec<LiveEntry>> {
        let manifests = self.manifests().await?;
        let loaded = futures::future::try_join_all(manifests.iter().map(|m| self.lake.manifest(m))).await?;
        Ok(loaded.iter().flat_map(|es| es.iter().filter(|e| e.status != ManifestStatus::Deleted).cloned()).collect())
    }
}

impl fmt::Debug for Table {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Table").field("name", &self.name).field("version", &self.version).finish_non_exhaustive()
    }
}
