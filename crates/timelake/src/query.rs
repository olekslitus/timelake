//! The Timelake reader: DataFusion over Timelake tables.
//!
//! What it adds over a generic Iceberg/Parquet scan (SPEC §12.2):
//! - **File pruning** on Iceberg column bounds (time range, series key) evaluated with DataFusion's
//!   `PruningPredicate`, then row-group and page pruning inside the (sorted) Parquet files.
//! - **Last-value rewrite:** "newest row per series" queries (`ROW_NUMBER() OVER (PARTITION BY
//!   <series key> ORDER BY <time> DESC) = 1`) and "newest row" queries (`ORDER BY <time> DESC
//!   LIMIT 1` filtered on the series key) are answered from the last-value index instead of a scan.
//! - `time_bucket(interval, ts [, origin])` as in TimescaleDB.
//! - Namespaces as SQL schemas: `SELECT … FROM iot.readings`.

use std::any::Any;
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use arrow::array::{ArrayRef, UInt64Array};
use arrow::datatypes::{DataType, SchemaRef};
use async_trait::async_trait;
use datafusion::catalog::{CatalogProvider, SchemaProvider, Session as DfSession, TableProvider};
use datafusion::common::stats::Precision;
use datafusion::common::tree_node::Transformed;
use datafusion::common::{Column, ColumnStatistics, DFSchema, ScalarValue, Statistics};
use datafusion::datasource::file_format::FileFormat;
use datafusion::datasource::file_format::parquet::ParquetFormat;
use datafusion::datasource::listing::PartitionedFile;
use datafusion::datasource::memory::MemorySourceConfig;
use datafusion::datasource::physical_plan::parquet::metadata::DFParquetMetadata;
use datafusion::datasource::physical_plan::{FileGroup, FileScanConfigBuilder, ParquetSource};
use datafusion::datasource::provider_as_source;
use datafusion::error::{DataFusionError, Result as DfResult};
use datafusion::execution::SessionStateBuilder;
use datafusion::execution::object_store::ObjectStoreUrl;
use datafusion::logical_expr::expr::{Sort, WindowFunction};
use datafusion::logical_expr::{
    BinaryExpr, Expr, LogicalPlan, Operator, Projection, TableProviderFilterPushDown, TableScan, TableType,
    WindowFunctionDefinition, utils::conjunction,
};
use datafusion::optimizer::{OptimizerConfig, OptimizerRule};
use datafusion::physical_expr::{LexOrdering, PhysicalSortExpr};
use datafusion::physical_optimizer::pruning::{PruningPredicate, PruningStatistics};
use datafusion::physical_plan::ExecutionPlan;
use datafusion::physical_plan::empty::EmptyExec;
use datafusion::prelude::{DataFrame, SessionConfig, SessionContext};
use iceberg::spec::{Datum, PrimitiveLiteral};

use crate::error::Result;
use crate::lake::{DEFAULT_NAMESPACE, Lake, LiveEntry, Table};

/// A SQL session over a lake. Tables are addressed as `namespace.table` (or just `table` in the
/// `default` namespace) and always read at their latest committed version.
#[derive(Clone)]
pub struct Session {
    lake: Lake,
    ctx: SessionContext,
}

impl Session {
    pub fn new(lake: Lake) -> Self {
        Self::with_config(lake, SessionConfig::new())
    }

    pub fn with_config(lake: Lake, config: SessionConfig) -> Self {
        // Unqualified table names resolve in `default` unless the caller chose a namespace.
        let schema = match config.options().catalog.default_schema.as_str() {
            "public" => DEFAULT_NAMESPACE.to_string(),
            s => s.to_string(),
        };
        // Scans of remote object storage are latency-bound: more partitions mean more requests in
        // flight. Raise the default (one per core) unless the caller changed it.
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(8);
        let remote = !matches!(lake.storage().base_url().split(':').next(), Some("file") | Some("memory"));
        let config = if remote && config.target_partitions() == cores {
            config.with_target_partitions((cores * 4).max(32))
        } else {
            config
        };
        let config = config
            .with_information_schema(true)
            .with_default_catalog_and_schema("timelake", schema)
            .set_bool("datafusion.execution.parquet.pushdown_filters", false);
        let state = SessionStateBuilder::new()
            .with_config(config)
            .with_default_features()
            .with_optimizer_rule(Arc::new(LatestRewrite))
            .build();
        let ctx = SessionContext::new_with_state(state);
        let base = lake.storage().base_url().to_string();
        ctx.register_object_store(&url::Url::parse(&format!("{base}/")).unwrap(), lake.storage().object_store());
        ctx.register_catalog("timelake", Arc::new(LakeCatalog { lake: lake.clone() }));
        // TimescaleDB's time_bucket(width, ts [, origin]) has date_bin's semantics for fixed widths.
        let tb = datafusion::functions::datetime::date_bin().as_ref().clone().with_aliases(["time_bucket"]);
        ctx.register_udf(tb);
        Self { lake, ctx }
    }

    pub fn lake(&self) -> &Lake {
        &self.lake
    }

    /// The underlying DataFusion context, for registering more tables or functions.
    pub fn context(&self) -> &SessionContext {
        &self.ctx
    }

    pub async fn sql(&self, sql: &str) -> Result<DataFrame> {
        let state = self.ctx.state();
        let dialect = state.config().options().sql_parser.dialect;
        let stmt = state.sql_to_statement(sql, &dialect)?;
        // DataFusion resolves tables one after another; on object storage each costs several
        // round trips (version hint, metadata, manifest list, manifests). Load every table the
        // query references concurrently first, so planning finds them all in cache.
        if let Ok(refs) = state.resolve_table_references(&stmt) {
            let default_ns = state.config().options().catalog.default_schema.clone();
            let names: Vec<String> = refs
                .iter()
                .filter(|r| r.catalog().is_none_or(|c| c == "timelake"))
                .map(|r| format!("{}.{}", r.schema().unwrap_or(&default_ns), r.table()))
                .collect();
            futures::future::join_all(names.iter().map(|n| self.prefetch(n))).await;
        }
        let plan = state.statement_to_plan(stmt).await?;
        Ok(self.ctx.execute_logical_plan(plan).await?)
    }

    async fn prefetch(&self, name: &str) {
        if let Ok(t) = self.lake.table_recent(name, PLAN_CACHE_TTL).await {
            let lvi = t.last_value_index();
            let (_, _) = tokio::join!(t.files(), async {
                if let Some(uri) = lvi {
                    let _ = crate::lvi::read(&t, &uri).await;
                }
            });
        }
    }

    /// The newest row of every series (from the last-value index when available).
    pub async fn latest(&self, table: &str) -> Result<DataFrame> {
        let t = self.lake.table(table).await?;
        let tc = t
            .contract
            .time_column
            .clone()
            .ok_or_else(|| crate::Error::invalid(format!("{table} has no time column")))?;
        if t.last_value_index().is_some() {
            return Ok(self.ctx.read_table(Arc::new(TimelakeProvider::latest(t)))?);
        }
        // Fallback for tables without an index: a window query.
        let keys = t.contract.series_key.iter().map(|k| format!("\"{k}\"")).collect::<Vec<_>>().join(", ");
        let part = if keys.is_empty() { String::new() } else { format!("PARTITION BY {keys}") };
        let sql = format!(
            "SELECT * EXCLUDE (__rn) FROM (SELECT *, ROW_NUMBER() OVER ({part} ORDER BY \"{tc}\" DESC) AS __rn FROM {}.{}) WHERE __rn = 1",
            t.name.namespace, t.name.name
        );
        self.sql(&sql).await
    }
}

/// How long a table version loaded for planning is reused by later planning in this process.
/// Commits made by this process are visible immediately regardless.
const PLAN_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(1);

#[derive(Debug)]
struct LakeCatalog {
    lake: Lake,
}

impl CatalogProvider for LakeCatalog {
    fn schema_names(&self) -> Vec<String> {
        block(self.lake.namespaces()).unwrap_or_default()
    }

    fn schema(&self, name: &str) -> Option<Arc<dyn SchemaProvider>> {
        Some(Arc::new(NamespaceSchema { lake: self.lake.clone(), namespace: name.to_string() }))
    }
}

impl fmt::Debug for Lake {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Lake({})", self.location())
    }
}

#[derive(Debug)]
struct NamespaceSchema {
    lake: Lake,
    namespace: String,
}

#[async_trait]
impl SchemaProvider for NamespaceSchema {
    fn table_names(&self) -> Vec<String> {
        block(self.lake.tables(&self.namespace)).map(|v| v.into_iter().map(|t| t.name).collect()).unwrap_or_default()
    }

    async fn table(&self, name: &str) -> DfResult<Option<Arc<dyn TableProvider>>> {
        match self.lake.table_recent(&format!("{}.{name}", self.namespace), PLAN_CACHE_TTL).await {
            Ok(t) => Ok(Some(Arc::new(TimelakeProvider::data(t)))),
            Err(crate::Error::NotFound(_)) | Err(crate::Error::Invalid(_)) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn table_exist(&self, name: &str) -> bool {
        block(self.lake.table(&format!("{}.{name}", self.namespace))).is_ok()
    }
}

/// Runs a future to completion from synchronous DataFusion catalog callbacks (only used for
/// listing, never on the query path).
fn block<F: std::future::Future>(f: F) -> F::Output {
    match tokio::runtime::Handle::try_current() {
        Ok(h) => tokio::task::block_in_place(|| h.block_on(f)),
        Err(_) => tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Data,
    Latest,
}

/// A Timelake table at the version loaded during planning.
#[derive(Clone)]
pub struct TimelakeProvider {
    table: Table,
    kind: Kind,
}

impl fmt::Debug for TimelakeProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "TimelakeProvider({}, v{}, {:?})", self.table.name, self.table.version, self.kind)
    }
}

impl TimelakeProvider {
    fn data(table: Table) -> Self {
        Self { table, kind: Kind::Data }
    }

    fn latest(table: Table) -> Self {
        Self { table, kind: Kind::Latest }
    }

    async fn scan_latest(&self, projection: Option<&Vec<usize>>) -> DfResult<Arc<dyn ExecutionPlan>> {
        let uri = self.table.last_value_index().ok_or_else(|| DataFusionError::Plan("no last-value index".into()))?;
        let batch = crate::lvi::read(&self.table, &uri).await?;
        Ok(MemorySourceConfig::try_new_exec(&[vec![batch]], self.table.schema(), projection.cloned())?)
    }

    async fn scan_data(
        &self,
        state: &dyn DfSession,
        projection: Option<&Vec<usize>>,
        filters: &[Expr],
        limit: Option<usize>,
    ) -> DfResult<Arc<dyn ExecutionPlan>> {
        let schema = self.table.schema();
        let mut files = self.table.files().await?;

        // File pruning on Iceberg column bounds.
        if let Some(pred) = conjunction(filters.iter().cloned()) {
            let df_schema = DFSchema::try_from(schema.as_ref().clone())?;
            let phys = state.create_physical_expr(pred, &df_schema)?;
            let pp = PruningPredicate::try_new(phys, schema.clone())?;
            let stats = FileStats::new(&schema, &self.table, &files);
            let keep = pp.prune(&stats)?;
            files = files.into_iter().zip(keep).filter_map(|(f, k)| k.then_some(f)).collect();
        }
        if files.is_empty() {
            let projected = match projection {
                Some(p) => Arc::new(schema.project(p)?),
                None => schema.clone(),
            };
            return Ok(Arc::new(EmptyExec::new(projected)));
        }

        let storage = self.table.lake.storage();
        let target = state.config().target_partitions().max(1);
        let n_groups = files.len().min(target);
        let mut groups: Vec<Vec<PartitionedFile>> = vec![vec![]; n_groups];
        // Biggest files first, round-robin: roughly balanced groups.
        files.sort_by_key(|f| std::cmp::Reverse(f.data_file.file_size_in_bytes()));
        let mut total_rows = 0usize;
        for (i, f) in files.iter().enumerate() {
            total_rows += f.data_file.record_count() as usize;
            let path = storage.path(f.data_file.file_path())?;
            let pf = PartitionedFile::new(path.to_string(), f.data_file.file_size_in_bytes())
                .with_statistics(Arc::new(file_statistics(&schema, f)));
            groups[i % n_groups].push(pf);
        }
        let one_file_per_group = groups.iter().all(|g| g.len() == 1);

        // Read each file's footer (and page index) once, concurrently, into DataFusion's metadata
        // cache. Otherwise every scan partition fetches the footer of the file range it reads,
        // which on object storage means dozens of redundant ranged GETs per file.
        let url = ObjectStoreUrl::parse(format!("{}/", storage.base_url()))?;
        let store = state.runtime_env().object_store(&url)?;
        let cache = state.runtime_env().cache_manager.get_file_metadata_cache();
        let hint = state.table_options().parquet.global.metadata_size_hint;
        let metas: Vec<_> = groups.iter().flatten().map(|pf| pf.object_meta.clone()).collect();
        let fetches = metas.iter().map(|m| {
            let (store, cache) = (store.clone(), cache.clone());
            async move {
                DFParquetMetadata::new(store.as_ref(), m)
                    .with_metadata_size_hint(hint)
                    .with_file_metadata_cache(Some(cache))
                    .fetch_metadata()
                    .await
            }
        });
        futures::future::try_join_all(fetches).await?;

        let source = Arc::new(ParquetSource::new(schema.clone()));
        let mut stats = Statistics::new_unknown(&schema);
        stats.num_rows = Precision::Exact(total_rows);
        let mut builder = FileScanConfigBuilder::new(url, source)
            .with_file_groups(groups.into_iter().map(FileGroup::new).collect())
            .with_statistics(stats)
            .with_projection_indices(projection.cloned())?
            .with_limit(if filters.is_empty() { limit } else { None });
        // Every file is sorted by (series…, time). Declaring it lets DataFusion skip sorts, but it also
        // keeps one partition per file (no byte-range splits), which costs more than it saves when a
        // few large compacted files hold the data. Only declare it when there are enough files.
        let declare_ordering = n_groups >= target;
        let sort_cols = self.table.contract.sort_columns();
        if declare_ordering && one_file_per_group && !sort_cols.is_empty() {
            let exprs = sort_cols
                .iter()
                .map(|c| {
                    let col = datafusion::physical_expr::expressions::col(c, &schema)?;
                    Ok(PhysicalSortExpr::new(col, arrow::compute::SortOptions { descending: false, nulls_first: true }))
                })
                .collect::<DfResult<Vec<_>>>()?;
            if let Some(o) = LexOrdering::new(exprs) {
                builder = builder.with_output_ordering(vec![o]);
            }
        }
        let format = ParquetFormat::default().with_options(state.table_options().parquet.clone());
        format.create_physical_plan(state, builder.build()).await
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
        match self.kind {
            Kind::Latest => self.scan_latest(projection).await,
            Kind::Data => self.scan_data(state, projection, filters, limit).await,
        }
    }

    fn supports_filters_pushdown(&self, filters: &[&Expr]) -> DfResult<Vec<TableProviderFilterPushDown>> {
        let kind = match self.kind {
            Kind::Data => TableProviderFilterPushDown::Inexact,
            Kind::Latest => TableProviderFilterPushDown::Unsupported,
        };
        Ok(vec![kind; filters.len()])
    }

    fn statistics(&self) -> Option<Statistics> {
        let rows = self.table.current_snapshot()?.summary().additional_properties.get("total-records")?.parse().ok()?;
        let mut s = Statistics::new_unknown(&self.table.schema());
        s.num_rows = Precision::Inexact(rows);
        Some(s)
    }
}

// --- statistics from Iceberg manifests -------------------------------------------------------------

/// Converts an Iceberg bound to a scalar of the Arrow column type.
fn datum_to_scalar(d: &Datum, dt: &DataType) -> Option<ScalarValue> {
    use PrimitiveLiteral as L;
    let v = match (d.literal(), dt) {
        (L::Boolean(b), DataType::Boolean) => ScalarValue::Boolean(Some(*b)),
        (L::Int(i), DataType::Int32) => ScalarValue::Int32(Some(*i)),
        (L::Int(i), DataType::Date32) => ScalarValue::Date32(Some(*i)),
        (L::Long(i), DataType::Int64) => ScalarValue::Int64(Some(*i)),
        (L::Long(i), DataType::Timestamp(arrow::datatypes::TimeUnit::Microsecond, tz)) => {
            ScalarValue::TimestampMicrosecond(Some(*i), tz.clone())
        }
        (L::Long(i), DataType::Timestamp(arrow::datatypes::TimeUnit::Nanosecond, tz)) => {
            ScalarValue::TimestampNanosecond(Some(*i), tz.clone())
        }
        (L::Float(f), DataType::Float32) => ScalarValue::Float32(Some(f.0)),
        (L::Double(f), DataType::Float64) => ScalarValue::Float64(Some(f.0)),
        (L::String(s), DataType::Utf8) => ScalarValue::Utf8(Some(s.clone())),
        _ => return None,
    };
    Some(v)
}

fn field_id(schema: &SchemaRef, idx: usize) -> Option<i32> {
    schema.field(idx).metadata().get(parquet::arrow::PARQUET_FIELD_ID_META_KEY)?.parse().ok()
}

fn file_statistics(schema: &SchemaRef, f: &LiveEntry) -> Statistics {
    let df = &f.data_file;
    let columns = (0..schema.fields().len())
        .map(|i| {
            let mut cs = ColumnStatistics::new_unknown();
            if let Some(id) = field_id(schema, i) {
                let dt = schema.field(i).data_type();
                if let Some(v) = df.lower_bounds().get(&id).and_then(|d| datum_to_scalar(d, dt)) {
                    cs.min_value = Precision::Inexact(v);
                }
                if let Some(v) = df.upper_bounds().get(&id).and_then(|d| datum_to_scalar(d, dt)) {
                    cs.max_value = Precision::Inexact(v);
                }
                if let Some(n) = df.null_value_counts().get(&id) {
                    cs.null_count = Precision::Exact(*n as usize);
                }
            }
            cs
        })
        .collect();
    Statistics {
        num_rows: Precision::Exact(df.record_count() as usize),
        total_byte_size: Precision::Inexact(df.file_size_in_bytes() as usize),
        column_statistics: columns,
    }
}

/// Per-file min/max/null/row counts for `PruningPredicate`.
struct FileStats {
    mins: HashMap<String, ArrayRef>,
    maxs: HashMap<String, ArrayRef>,
    nulls: HashMap<String, ArrayRef>,
    rows: ArrayRef,
    n: usize,
}

impl FileStats {
    fn new(schema: &SchemaRef, _table: &Table, files: &[LiveEntry]) -> Self {
        let (mut mins, mut maxs, mut nulls) = (HashMap::new(), HashMap::new(), HashMap::new());
        for (i, field) in schema.fields().iter().enumerate() {
            let Some(id) = field_id(schema, i) else { continue };
            let dt = field.data_type();
            let Ok(null) = ScalarValue::try_from(dt) else { continue };
            let col = |get: &dyn Fn(&LiveEntry) -> Option<ScalarValue>| {
                ScalarValue::iter_to_array(files.iter().map(|f| get(f).unwrap_or_else(|| null.clone()))).ok()
            };
            if let Some(a) = col(&|f| f.data_file.lower_bounds().get(&id).and_then(|d| datum_to_scalar(d, dt))) {
                mins.insert(field.name().clone(), a);
            }
            if let Some(a) = col(&|f| f.data_file.upper_bounds().get(&id).and_then(|d| datum_to_scalar(d, dt))) {
                maxs.insert(field.name().clone(), a);
            }
            let nc: UInt64Array = files.iter().map(|f| f.data_file.null_value_counts().get(&id).copied()).collect();
            nulls.insert(field.name().clone(), Arc::new(nc) as ArrayRef);
        }
        let rows: UInt64Array = files.iter().map(|f| Some(f.data_file.record_count())).collect();
        Self { mins, maxs, nulls, rows: Arc::new(rows), n: files.len() }
    }
}

impl PruningStatistics for FileStats {
    fn min_values(&self, column: &Column) -> Option<ArrayRef> {
        self.mins.get(&column.name).cloned()
    }
    fn max_values(&self, column: &Column) -> Option<ArrayRef> {
        self.maxs.get(&column.name).cloned()
    }
    fn num_containers(&self) -> usize {
        self.n
    }
    fn null_counts(&self, column: &Column) -> Option<ArrayRef> {
        self.nulls.get(&column.name).cloned()
    }
    fn row_counts(&self) -> Option<ArrayRef> {
        Some(self.rows.clone())
    }
    fn contained(
        &self,
        _column: &Column,
        _values: &std::collections::HashSet<ScalarValue>,
    ) -> Option<arrow::array::BooleanArray> {
        None
    }
}

// --- last-value rewrite ---------------------------------------------------------------------------

/// Rewrites latest-row queries onto the last-value index. See the module docs for the patterns.
#[derive(Debug)]
struct LatestRewrite;

impl OptimizerRule for LatestRewrite {
    fn name(&self) -> &str {
        "timelake_latest_rewrite"
    }

    fn rewrite(&self, plan: LogicalPlan, _config: &dyn OptimizerConfig) -> DfResult<Transformed<LogicalPlan>> {
        use datafusion::common::tree_node::TreeNode;
        plan.transform_down(|node| {
            if let Some(new) = rewrite_row_number(&node)? {
                return Ok(Transformed::yes(new));
            }
            if let Some(new) = rewrite_top1(&node)? {
                return Ok(Transformed::yes(new));
            }
            Ok(Transformed::no(node))
        })
    }
}

/// The Timelake data table behind a scan, if it has a last-value index.
fn indexed_table(scan: &TableScan) -> Option<Table> {
    let provider = datafusion::datasource::source_as_provider(&scan.source).ok()?;
    let any: &dyn Any = provider.as_ref();
    let p = any.downcast_ref::<TimelakeProvider>()?;
    (p.kind == Kind::Data && p.table.last_value_index().is_some() && p.table.contract.time_column.is_some())
        .then(|| p.table.clone())
}

fn latest_scan(scan: &TableScan, table: Table) -> LogicalPlan {
    let mut s = scan.clone();
    s.source = provider_as_source(Arc::new(TimelakeProvider::latest(table)));
    s.filters = vec![];
    LogicalPlan::TableScan(s)
}

fn is_one(e: &Expr) -> bool {
    matches!(e, Expr::Literal(v, _) if v.to_string() == "1")
}

/// Skips pass-through projections (plain column references).
fn through_projections(plan: &LogicalPlan) -> &LogicalPlan {
    match plan {
        LogicalPlan::Projection(p) if p.expr.iter().all(|e| matches!(e, Expr::Column(_))) => {
            through_projections(&p.input)
        }
        other => other,
    }
}

/// `Filter(rn = 1) ← [Projection] ← Window(row_number() PARTITION BY series ORDER BY time DESC) ← Scan`
fn rewrite_row_number(node: &LogicalPlan) -> DfResult<Option<LogicalPlan>> {
    let LogicalPlan::Filter(filter) = node else { return Ok(None) };
    // `rn = 1`, possibly AND-ed with other predicates (which are kept in a filter above).
    let conjuncts = datafusion::logical_expr::utils::split_conjunction(&filter.predicate);
    let mut rn_col = None;
    let mut others = vec![];
    for c in conjuncts {
        let hit = match c {
            Expr::BinaryExpr(BinaryExpr { left, op: Operator::Eq, right }) => match (left.as_ref(), right.as_ref()) {
                (Expr::Column(col), r) if is_one(r) && rn_col.is_none() => Some(col),
                (l, Expr::Column(col)) if is_one(l) && rn_col.is_none() => Some(col),
                _ => None,
            },
            _ => None,
        };
        match hit {
            Some(col) => rn_col = Some(col),
            None => others.push(c.clone()),
        }
    }
    let Some(rn_col) = rn_col else { return Ok(None) };
    if others.iter().any(|e| e.column_refs().iter().any(|c| c.name == rn_col.name)) {
        return Ok(None);
    }
    // Find the window node, allowing column-only/alias projections in between.
    let mut cur = filter.input.as_ref();
    let mut projections = vec![];
    let window = loop {
        match cur {
            LogicalPlan::Projection(p) => {
                projections.push(p);
                cur = &p.input;
            }
            LogicalPlan::Window(w) => break w,
            _ => return Ok(None),
        }
    };
    if window.window_expr.len() != 1 {
        return Ok(None);
    }
    let LogicalPlan::TableScan(scan) = window.input.as_ref() else { return Ok(None) };
    if !scan.filters.is_empty() || scan.fetch.is_some() {
        return Ok(None);
    }
    let Some(table) = indexed_table(scan) else { return Ok(None) };
    let wexpr = window.window_expr[0].clone().unalias();
    let Expr::WindowFunction(wf) = &wexpr else { return Ok(None) };
    let WindowFunction { fun, params } = wf.as_ref();
    if !matches!(fun, WindowFunctionDefinition::WindowUDF(u) if u.name() == "row_number") {
        return Ok(None);
    }
    let names = |es: &[Expr]| {
        es.iter()
            .map(|e| match e {
                Expr::Column(c) => Some(c.name.clone()),
                _ => None,
            })
            .collect::<Option<Vec<_>>>()
    };
    if names(&params.partition_by) != Some(table.contract.series_key.clone()) {
        return Ok(None);
    }
    let tc = table.contract.time_column.clone().unwrap();
    match params.order_by.as_slice() {
        [Sort { expr: Expr::Column(c), asc: false, .. }] if c.name == tc => {}
        _ => return Ok(None),
    }
    // The filter column must be the window output (directly or via an alias in a projection).
    let wname = window.schema.field(window.schema.fields().len() - 1).name().clone();
    let refers = rn_col.name == wname
        || projections.iter().any(|p| {
            p.expr.iter().any(|e| matches!(e, Expr::Alias(a) if a.name == rn_col.name && matches!(a.expr.as_ref(), Expr::Column(c) if c.name == wname)))
        });
    if !refers {
        return Ok(None);
    }
    // Window → Projection(input columns…, 1 AS <window column>) over the index scan.
    let new_scan = latest_scan(scan, table);
    let mut exprs: Vec<Expr> = scan.projected_schema.columns().into_iter().map(Expr::Column).collect();
    let (q, f) = window.schema.qualified_field(window.schema.fields().len() - 1);
    exprs.push(Expr::Literal(ScalarValue::UInt64(Some(1)), None).alias_qualified(q.cloned(), f.name()));
    let proj =
        LogicalPlan::Projection(Projection::try_new_with_schema(exprs, Arc::new(new_scan), window.schema.clone())?);
    // Rebuild the projections between filter and window on top, keeping the filter (always true).
    let mut rebuilt = proj;
    for p in projections.iter().rev() {
        rebuilt = LogicalPlan::Projection(Projection::try_new_with_schema(
            p.expr.clone(),
            Arc::new(rebuilt),
            p.schema.clone(),
        )?);
    }
    match conjunction(others) {
        Some(pred) => {
            Ok(Some(LogicalPlan::Filter(datafusion::logical_expr::Filter::try_new(pred, Arc::new(rebuilt))?)))
        }
        None => Ok(Some(rebuilt)),
    }
}

/// `Limit(1) ← Sort(time DESC) ← [Filter on series key] ← Scan(filters on series key)`
fn rewrite_top1(node: &LogicalPlan) -> DfResult<Option<LogicalPlan>> {
    let (sort, fetch) = match node {
        LogicalPlan::Sort(s) => (s, s.fetch),
        _ => return Ok(None),
    };
    if fetch != Some(1) {
        return Ok(None);
    }
    let mut cur = through_projections(&sort.input);
    let mut filters: Vec<&Expr> = vec![];
    if let LogicalPlan::Filter(f) = cur {
        filters.push(&f.predicate);
        cur = through_projections(&f.input);
    }
    let LogicalPlan::TableScan(scan) = cur else { return Ok(None) };
    if scan.fetch.is_some() {
        return Ok(None);
    }
    let Some(table) = indexed_table(scan) else { return Ok(None) };
    let tc = table.contract.time_column.clone().unwrap();
    match sort.expr.as_slice() {
        [Sort { expr: Expr::Column(c), asc: false, .. }] if c.name == tc => {}
        _ => return Ok(None),
    }
    // Every filter must only reference series key columns: then the newest matching row is the
    // newest among those series' newest rows.
    let key: std::collections::HashSet<&str> = table.contract.series_key.iter().map(String::as_str).collect();
    let only_keys = |e: &Expr| e.column_refs().iter().all(|c| key.contains(c.name.as_str()));
    if key.is_empty() || !filters.iter().all(|e| only_keys(e)) || !scan.filters.iter().all(only_keys) {
        return Ok(None);
    }
    let mut filters_in_scan = scan.filters.clone();
    let new_scan = latest_scan(scan, table);
    // The index scan doesn't take pushed-down filters: re-apply them above it.
    let input = match conjunction(filters_in_scan.drain(..)) {
        Some(pred) if filters.is_empty() => {
            LogicalPlan::Filter(datafusion::logical_expr::Filter::try_new(pred, Arc::new(new_scan))?)
        }
        _ => new_scan,
    };
    let replaced = replace_scan(&sort.input, input)?;
    Ok(Some(node.with_new_exprs(node.expressions(), vec![replaced])?))
}

/// Replaces the single table scan under `plan` with `new`.
fn replace_scan(plan: &LogicalPlan, new: LogicalPlan) -> DfResult<LogicalPlan> {
    match plan {
        LogicalPlan::TableScan(_) => Ok(new),
        other => {
            let inputs = other.inputs();
            if inputs.len() != 1 {
                return Err(DataFusionError::Internal("unexpected plan shape".into()));
            }
            let child = replace_scan(inputs[0], new)?;
            other.with_new_exprs(other.expressions(), vec![child])
        }
    }
}
