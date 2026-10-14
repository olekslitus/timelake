//! A Timelake table as a DataFusion table: pruned Parquet scans, or the last-value index.

use std::fmt;
use std::sync::Arc;

use arrow::datatypes::SchemaRef;
use async_trait::async_trait;
use datafusion::catalog::{Session as DfSession, TableProvider};
use datafusion::common::DFSchema;
use datafusion::common::Statistics;
use datafusion::common::stats::Precision;
use datafusion::datasource::file_format::FileFormat;
use datafusion::datasource::file_format::parquet::ParquetFormat;
use datafusion::datasource::listing::PartitionedFile;
use datafusion::datasource::memory::MemorySourceConfig;
use datafusion::datasource::physical_plan::parquet::metadata::DFParquetMetadata;
use datafusion::datasource::physical_plan::{FileGroup, FileScanConfigBuilder, ParquetSource};
use datafusion::error::{DataFusionError, Result as DfResult};
use datafusion::execution::object_store::ObjectStoreUrl;
use datafusion::logical_expr::utils::conjunction;
use datafusion::logical_expr::{Expr, TableProviderFilterPushDown, TableType};
use datafusion::physical_expr::{LexOrdering, PhysicalSortExpr};
use datafusion::physical_optimizer::pruning::PruningPredicate;
use datafusion::physical_plan::ExecutionPlan;
use datafusion::physical_plan::empty::EmptyExec;

use super::stats::{FileStats, file_statistics};
use crate::sort::ASCENDING;
use crate::summary;
use crate::table::{LiveEntry, Table};

/// What a [`TimelakeProvider`] reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Kind {
    /// The table's data files.
    Data,
    /// The last-value index: the newest row of every series.
    Latest,
}

/// A Timelake table at the version loaded during planning.
#[derive(Clone)]
pub(crate) struct TimelakeProvider {
    table: Table,
    kind: Kind,
}

impl TimelakeProvider {
    pub(super) fn data(table: Table) -> Self {
        Self { table, kind: Kind::Data }
    }

    pub(super) fn latest(table: Table) -> Self {
        Self { table, kind: Kind::Latest }
    }

    pub(super) fn table(&self) -> &Table {
        &self.table
    }

    pub(super) fn kind(&self) -> Kind {
        self.kind
    }

    /// Plans the scan of `table`, the version this provider was planned with or a newer one with
    /// the same schema.
    async fn scan_version(
        &self,
        table: &Table,
        state: &dyn DfSession,
        projection: Option<&Vec<usize>>,
        filters: &[Expr],
        limit: Option<usize>,
    ) -> DfResult<Arc<dyn ExecutionPlan>> {
        match self.kind {
            Kind::Latest => scan_latest(table, projection).await,
            Kind::Data => scan_data(table, state, projection, filters, limit).await,
        }
    }
}

async fn scan_latest(table: &Table, projection: Option<&Vec<usize>>) -> DfResult<Arc<dyn ExecutionPlan>> {
    let uri = table.last_value_index().ok_or_else(|| DataFusionError::Plan("no last-value index".into()))?;
    let batch = crate::lvi::read(table, &uri).await?;
    Ok(MemorySourceConfig::try_new_exec(&[vec![batch]], table.schema(), projection.cloned())?)
}

async fn scan_data(
    table: &Table,
    state: &dyn DfSession,
    projection: Option<&Vec<usize>>,
    filters: &[Expr],
    limit: Option<usize>,
) -> DfResult<Arc<dyn ExecutionPlan>> {
    let schema = table.schema();
    let mut files = prune(table, state, filters).await?;
    if files.is_empty() {
        let projected = match projection {
            Some(p) => Arc::new(schema.project(p)?),
            None => schema.clone(),
        };
        return Ok(Arc::new(EmptyExec::new(projected)));
    }

    let storage = table.lake().storage();
    let target = state.config().target_partitions().max(1);
    let n_groups = files.len().min(target);
    let mut groups: Vec<Vec<PartitionedFile>> = vec![vec![]; n_groups];
    // Biggest files first, round-robin: roughly balanced groups.
    files.sort_by_key(|f| std::cmp::Reverse(f.data_file.file_size_in_bytes()));
    let mut total_rows = 0u64;
    for (i, f) in files.iter().enumerate() {
        total_rows += f.data_file.record_count();
        let path = storage.path(f.data_file.file_path())?;
        let pf = PartitionedFile::new(path.to_string(), f.data_file.file_size_in_bytes())
            .with_statistics(Arc::new(file_statistics(&schema, f)));
        groups[i % n_groups].push(pf);
    }
    let one_file_per_group = groups.iter().all(|g| g.len() == 1);

    let url = ObjectStoreUrl::parse(storage.url())?;
    prefetch_footers(state, &url, &groups).await?;

    let source = Arc::new(ParquetSource::new(schema.clone()));
    let mut stats = Statistics::new_unknown(&schema);
    stats.num_rows = Precision::Exact(usize::try_from(total_rows).unwrap_or(usize::MAX));
    let mut builder = FileScanConfigBuilder::new(url, source)
        .with_file_groups(groups.into_iter().map(FileGroup::new).collect())
        .with_statistics(stats)
        .with_projection_indices(projection.cloned())?
        .with_limit(if filters.is_empty() { limit } else { None });
    // Every file is sorted by (series…, time). Declaring it lets DataFusion skip sorts, but it also
    // keeps one partition per file (no byte-range splits), which costs more than it saves when a
    // few large compacted files hold the data. Only declare it when there are enough files.
    let sort_columns = table.contract().sort_columns();
    if n_groups >= target && one_file_per_group && !sort_columns.is_empty() {
        let exprs = sort_columns
            .iter()
            .map(|c| Ok(PhysicalSortExpr::new(datafusion::physical_expr::expressions::col(c, &schema)?, ASCENDING)))
            .collect::<DfResult<Vec<_>>>()?;
        if let Some(ordering) = LexOrdering::new(exprs) {
            builder = builder.with_output_ordering(vec![ordering]);
        }
    }
    let format = ParquetFormat::default().with_options(state.table_options().parquet.clone());
    format.create_physical_plan(state, builder.build()).await
}

/// Live files whose Iceberg column bounds can match `filters`.
async fn prune(table: &Table, state: &dyn DfSession, filters: &[Expr]) -> DfResult<Vec<LiveEntry>> {
    let files = table.files().await?;
    let Some(predicate) = conjunction(filters.iter().cloned()) else { return Ok(files) };
    let schema = table.schema();
    let df_schema = DFSchema::try_from(schema.as_ref().clone())?;
    let predicate = PruningPredicate::try_new(state.create_physical_expr(predicate, &df_schema)?, schema.clone())?;
    let keep = predicate.prune(&FileStats::new(&schema, &files))?;
    Ok(files.into_iter().zip(keep).filter_map(|(f, k)| k.then_some(f)).collect())
}

/// Reads each file's footer (and page index) once, concurrently, into DataFusion's metadata
/// cache. Otherwise every scan partition fetches the footer of the file range it reads, which on
/// object storage means dozens of redundant ranged GETs per file.
async fn prefetch_footers(
    state: &dyn DfSession,
    url: &ObjectStoreUrl,
    groups: &[Vec<PartitionedFile>],
) -> DfResult<()> {
    let store = state.runtime_env().object_store(url)?;
    let cache = state.runtime_env().cache_manager.get_file_metadata_cache();
    let hint = state.table_options().parquet.global.metadata_size_hint;
    let fetches = groups.iter().flatten().map(|pf| {
        let (store, cache) = (store.clone(), cache.clone());
        async move {
            DFParquetMetadata::new(store.as_ref(), &pf.object_meta)
                .with_metadata_size_hint(hint)
                .with_file_metadata_cache(Some(cache))
                .fetch_metadata()
                .await
        }
    });
    futures::future::try_join_all(fetches).await?;
    Ok(())
}

impl fmt::Debug for TimelakeProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "TimelakeProvider({}, v{}, {:?})", self.table.name(), self.table.version(), self.kind)
    }
}

#[async_trait]
impl TableProvider for TimelakeProvider {
    fn schema(&self) -> SchemaRef {
        self.table.schema()
    }

    fn table_type(&self) -> TableType {
        TableType::Base
    }

    async fn scan(
        &self,
        state: &dyn DfSession,
        projection: Option<&Vec<usize>>,
        filters: &[Expr],
        limit: Option<usize>,
    ) -> DfResult<Arc<dyn ExecutionPlan>> {
        // A version loaded from the head is checked for a newer one while it is planned; an
        // outdated plan is replaced by one of the current version.
        let (stale, plan) =
            tokio::join!(self.table.is_stale(), self.scan_version(&self.table, state, projection, filters, limit));
        if !stale.map_err(|e| DataFusionError::External(Box::new(e)))? {
            return plan;
        }
        let current = self.table.lake().load(self.table.name()).await?;
        if current.schema() != self.table.schema() {
            let name = self.table.name();
            return Err(DataFusionError::Plan(format!("{name} changed while the query was planned; run it again")));
        }
        self.scan_version(&current, state, projection, filters, limit).await
    }

    fn supports_filters_pushdown(&self, filters: &[&Expr]) -> DfResult<Vec<TableProviderFilterPushDown>> {
        let support = match self.kind {
            Kind::Data => TableProviderFilterPushDown::Inexact,
            Kind::Latest => TableProviderFilterPushDown::Unsupported,
        };
        Ok(vec![support; filters.len()])
    }

    fn statistics(&self) -> Option<Statistics> {
        let rows = self.table.summary_value(summary::TOTAL_RECORDS)?.parse().ok()?;
        let mut s = Statistics::new_unknown(&self.table.schema());
        s.num_rows = Precision::Inexact(rows);
        Some(s)
    }
}
