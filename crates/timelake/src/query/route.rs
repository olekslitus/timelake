//! Rollup routing (SPEC §11.1): a `GROUP BY time_bucket(…)` query on a raw table, answered from a
//! rollup for the buckets the rollup has right, and from the raw table for the rest.
//!
//! Which buckets a rollup has right takes I/O to find out (its record, the raw table's files), and
//! optimizer rules can't do I/O: [`prepare`] works it out before planning, and [`RollupRewrite`]
//! uses it while optimizing.

use std::any::Any;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, PoisonError, RwLock};

use arrow::datatypes::{DataType, TimeUnit};
use datafusion::common::tree_node::{Transformed, TreeNode};
use datafusion::common::{Column, ScalarValue, TableReference};
use datafusion::datasource::{provider_as_source, source_as_provider};
use datafusion::error::Result as DfResult;
use datafusion::logical_expr::utils::split_conjunction;
use datafusion::logical_expr::{
    Aggregate, BinaryExpr, Expr, ExprSchemable, Filter, LogicalPlan, LogicalPlanBuilder, Operator, Projection, Union,
};
use datafusion::optimizer::{OptimizerConfig, OptimizerRule};
use datafusion::prelude::ident;

use super::PLAN_CACHE_TTL;
use super::provider::{Kind, TimelakeProvider};
use super::rollup::{aggregate_of, bucket_width, is_time, unalias};
use super::settings::SessionSettings;
use crate::lake::Lake;
use crate::name::TableName;
use crate::property;
use crate::rollup::{Definition, Ranges, changed, floor, in_history, micros, recorded_sequence};
use crate::table::Table;

/// Stands for no bound: beyond any time a table holds (about ±73,000 years), with room to add a
/// bucket width without overflow.
const FAR: i64 = i64::MAX / 2;

/// The rollups that may answer queries on one version of a raw table.
#[derive(Debug)]
pub(super) struct Routes {
    version: u64,
    rollups: Vec<Candidate>,
}

#[derive(Debug)]
struct Candidate {
    def: Definition,
    /// The rollup at the version whose record `clean` was worked out from.
    rollup: Table,
    /// The buckets this version of the rollup has right: unchanged in the raw table since its
    /// refresh, and within both tables' retention. Bucket-aligned, half-open.
    clean: Ranges,
}

/// Routes by raw table, shared by a session and its optimizer rule.
pub(super) type RouteMap = Arc<RwLock<HashMap<TableName, Arc<Routes>>>>;

/// Works out the routes of raw table `name` for the next query, or forgets them when it has no
/// rollups to route to. The table version is confirmed current first, so the rule only routes a
/// version that won't be replaced while it is scanned.
pub(super) async fn prepare(lake: &Lake, name: &TableName, routes: &RouteMap) {
    let prepared = routes_for(lake, name).await;
    let mut map = routes.write().unwrap_or_else(PoisonError::into_inner);
    match prepared {
        Some(r) => map.insert(name.clone(), Arc::new(r)),
        None => map.remove(name),
    };
}

async fn routes_for(lake: &Lake, name: &TableName) -> Option<Routes> {
    let mut raw = lake.table_recent(name, PLAN_CACHE_TTL).await.ok()?;
    if raw.contract().rollups.is_empty() || !raw.contract().rollup_routing {
        return None;
    }
    if raw.is_stale().await.ok()? {
        raw = lake.load(name).await.ok()?;
    }
    let files = raw.files().await.ok()?;
    let now = chrono::Utc::now().timestamp_micros();
    let mut rollups = vec![];
    for rollup_name in &raw.contract().rollups {
        let Ok(rollup_name) = rollup_name.parse::<TableName>() else { continue };
        let Ok(rollup) = lake.table_recent(&rollup_name, PLAN_CACHE_TTL).await else { continue };
        let Ok(def) = Definition::of(&rollup) else { continue };
        let Some(recorded) = recorded_sequence(&rollup) else { continue };
        if def.source != *name || !in_history(&raw, &rollup) {
            continue;
        }
        let Some(dirty) = changed(&raw, &files, Some(recorded), def.width) else { continue };
        // Retention drops whole partitions that end before now minus the retention: buckets from
        // there on are complete in a table (and were when the rollup computed them).
        let kept = |t: &Table| t.contract().retention.map(|r| now.saturating_sub(micros(r)));
        let from = [kept(&raw), kept(&rollup)].into_iter().flatten().max();
        let from = from.map_or(-FAR, |t| ceil(t, def.width));
        let clean = complement(&dirty, from, FAR);
        rollups.push(Candidate { def, rollup: rollup.without_check(), clean });
    }
    (!rollups.is_empty()).then_some(Routes { version: raw.version(), rollups })
}

/// The start of the first bucket at or after `t`.
fn ceil(t: i64, width: i64) -> i64 {
    let f = floor(t, width);
    if f == t { f } else { f.saturating_add(width) }
}

/// `[from, to)` minus the (sorted, merged) `ranges`.
fn complement(ranges: &[(i64, i64)], from: i64, to: i64) -> Ranges {
    let mut out = vec![];
    let mut start = from;
    for &(lo, hi) in ranges {
        if lo > start {
            out.push((start, lo.min(to)));
        }
        start = start.max(hi);
    }
    if start < to {
        out.push((start, to));
    }
    out.retain(|(lo, hi)| lo < hi);
    out
}

/// The optimizer rule.
#[derive(Debug)]
pub(super) struct RollupRewrite {
    pub(super) routes: RouteMap,
}

impl OptimizerRule for RollupRewrite {
    fn name(&self) -> &'static str {
        "timelake_rollup_routing"
    }

    fn rewrite(&self, plan: LogicalPlan, config: &dyn OptimizerConfig) -> DfResult<Transformed<LogicalPlan>> {
        let options = config.options();
        let settings = options.extensions.get::<SessionSettings>();
        if settings.and_then(|s| s.flag(property::ROLLUP_ROUTING)) == Some(false) {
            return Ok(Transformed::no(plan));
        }
        let read_dedup = settings.and_then(|s| s.flag(property::READ_DEDUP));
        plan.transform_down(|node| {
            let LogicalPlan::Aggregate(a) = &node else { return Ok(Transformed::no(node)) };
            match self.route(a, read_dedup)? {
                Some(routed) => Ok(Transformed::yes(routed)),
                None => Ok(Transformed::no(node)),
            }
        })
    }
}

/// What a query asks of a raw table, read off its plan.
struct Query<'a> {
    table: Table,
    time: String,
    width: i64,
    keys: HashSet<&'a str>,
    aggregates: Vec<(String, Option<String>)>,
    /// Inclusive bounds on the time column, in microseconds.
    from: i64,
    to: i64,
    /// Filters on grouping columns, which apply to the rollup's rows as they do to the raw rows.
    key_filters: Vec<&'a Expr>,
}

impl RollupRewrite {
    fn route(&self, a: &Aggregate, read_dedup: Option<bool>) -> DfResult<Option<LogicalPlan>> {
        let Some(q) = read_query(a) else { return Ok(None) };
        let contract = q.table.contract();
        if contract.dedup && read_dedup == Some(false) {
            return Ok(None);
        }
        let routes = self.routes.read().unwrap_or_else(PoisonError::into_inner).get(q.table.name()).cloned();
        let Some(routes) = routes.filter(|r| r.version == q.table.version()) else { return Ok(None) };
        for candidate in &routes.rollups {
            let Some(columns) = candidate.answers(&q) else { continue };
            let Some((first, last)) = full_buckets(q.from, q.to, q.width) else { return Ok(None) };
            let from_rollup: Ranges = candidate
                .clean
                .iter()
                .map(|&(lo, hi)| (lo.max(first), hi.min(last)))
                .filter(|(lo, hi)| lo < hi)
                .collect();
            if from_rollup.is_empty() {
                continue;
            }
            return Ok(Some(rewrite(a, &q, candidate, &columns, &from_rollup)?));
        }
        Ok(None)
    }
}

impl Candidate {
    /// The rollup columns answering the query's aggregates, in order, if this rollup can.
    fn answers(&self, q: &Query<'_>) -> Option<Vec<String>> {
        let keys: HashSet<&str> = self.def.keys.iter().map(String::as_str).collect();
        if self.def.width != q.width || keys != q.keys {
            return None;
        }
        q.aggregates
            .iter()
            .map(|(function, column)| {
                let a = self.def.aggregates.iter().find(|a| a.function == *function && a.column == *column)?;
                Some(a.name.clone())
            })
            .collect()
    }
}

/// The query's shape, if it is a bucketed aggregate of a Timelake table not routed yet.
fn read_query(a: &Aggregate) -> Option<Query<'_>> {
    let mut filters: Vec<&Expr> = vec![];
    let mut input = a.input.as_ref();
    let scan = loop {
        match input {
            LogicalPlan::Filter(f) => {
                filters.extend(split_conjunction(&f.predicate));
                input = &f.input;
            }
            LogicalPlan::SubqueryAlias(s) => input = &s.input,
            LogicalPlan::Projection(p) if p.expr.iter().all(|e| matches!(e, Expr::Column(_))) => input = &p.input,
            LogicalPlan::TableScan(s) => break s,
            _ => return None,
        }
    };
    if scan.fetch.is_some() {
        return None;
    }
    let provider = source_as_provider(&scan.source).ok()?;
    let p = (provider.as_ref() as &dyn Any).downcast_ref::<TimelakeProvider>()?;
    if p.kind() != Kind::Data || p.is_routed() {
        return None;
    }
    let table = p.table().clone();
    let time = table.contract().time_column.clone()?;
    filters.extend(scan.filters.iter());

    let mut width = None;
    let mut keys = HashSet::new();
    for g in &a.group_expr {
        match (bucket_width(g, &time), unalias(g)) {
            (Some(w), _) if width.is_none() => width = Some(w),
            (None, Expr::Column(c)) => {
                keys.insert(c.name.as_str());
            }
            _ => return None,
        }
    }
    let aggregates = a.aggr_expr.iter().map(|e| aggregate_of(e, &time)).collect::<Option<Vec<_>>>()?;
    let (mut from, mut to) = (i64::MIN, i64::MAX);
    let mut key_filters = vec![];
    for f in filters {
        let columns = f.column_refs();
        if !columns.is_empty() && columns.iter().all(|c| keys.contains(c.name.as_str())) {
            if !key_filters.contains(&f) {
                key_filters.push(f);
            }
            continue;
        }
        let (lo, hi) = time_bounds(f, &time)?;
        (from, to) = (from.max(lo), to.min(hi));
    }
    Some(Query { table, time, width: width?, keys, aggregates, from, to, key_filters })
}

/// The inclusive bounds (µs) a comparison of the time column with a constant puts on it.
fn time_bounds(e: &Expr, time: &str) -> Option<(i64, i64)> {
    match e {
        Expr::BinaryExpr(BinaryExpr { left, op, right }) => {
            let (op, value) = match (is_time(left, time), is_time(right, time)) {
                (true, false) => (*op, nanos(right)?),
                (false, true) => (op.swap()?, nanos(left)?),
                _ => return None,
            };
            let (floor_us, ceil_us) = (value.div_euclid(1000), -(-value).div_euclid(1000));
            let (lo, hi) = match op {
                Operator::Gt => (floor_us + 1, i128::from(i64::MAX)),
                Operator::GtEq => (ceil_us, i128::from(i64::MAX)),
                Operator::Lt => (i128::from(i64::MIN), ceil_us - 1),
                Operator::LtEq => (i128::from(i64::MIN), floor_us),
                Operator::Eq => (ceil_us, floor_us),
                _ => return None,
            };
            Some((clamp(lo), clamp(hi)))
        }
        Expr::Between(b) if !b.negated && is_time(&b.expr, time) => {
            let lo = -(-nanos(&b.low)?).div_euclid(1000);
            let hi = nanos(&b.high)?.div_euclid(1000);
            Some((clamp(lo), clamp(hi)))
        }
        _ => None,
    }
}

fn clamp(v: i128) -> i64 {
    i64::try_from(v).unwrap_or(if v < 0 { i64::MIN } else { i64::MAX })
}

/// A timestamp constant in nanoseconds.
fn nanos(e: &Expr) -> Option<i128> {
    let Expr::Literal(v, _) = e else { return None };
    Some(match v {
        ScalarValue::TimestampSecond(Some(t), _) => i128::from(*t) * 1_000_000_000,
        ScalarValue::TimestampMillisecond(Some(t), _) => i128::from(*t) * 1_000_000,
        ScalarValue::TimestampMicrosecond(Some(t), _) => i128::from(*t) * 1_000,
        ScalarValue::TimestampNanosecond(Some(t), _) => i128::from(*t),
        _ => return None,
    })
}

/// The buckets entirely within `[from, to]` (inclusive µs), as a half-open range of bucket starts.
fn full_buckets(from: i64, to: i64, width: i64) -> Option<(i64, i64)> {
    let first = if from == i64::MIN { -FAR } else { ceil(from, width).max(-FAR) };
    let last = if to == i64::MAX { FAR } else { floor(to.checked_add(1)?, width).min(FAR) };
    (first < last).then_some((first, last))
}

/// `UNION ALL` of the aggregate over the raw rows outside `from_rollup` and the rollup's rows in
/// it, under the aggregate's own schema.
fn rewrite(
    a: &Aggregate,
    q: &Query<'_>,
    candidate: &Candidate,
    columns: &[String],
    from_rollup: &[(i64, i64)],
) -> DfResult<LogicalPlan> {
    // Raw side: the same aggregate, over the rows of the other buckets.
    let input_schema = a.input.schema();
    let (qualifier, field) = input_schema.qualified_field_with_unqualified_name(&q.time)?;
    let tz = match field.data_type() {
        DataType::Timestamp(TimeUnit::Microsecond, tz) => tz.clone(),
        _ => return Ok(LogicalPlan::Aggregate(a.clone())),
    };
    let time = Expr::Column(Column::new(qualifier.cloned(), &q.time));
    let at =
        |t: i64, tz: &Option<Arc<str>>| Expr::Literal(ScalarValue::TimestampMicrosecond(Some(t), tz.clone()), None);
    // Open ends (no time filter on that side) need no bound.
    let (open_from, open_to) = (FAR.saturating_neg(), FAR);
    let outside = from_rollup
        .iter()
        .filter_map(|&(lo, hi)| {
            let before = (lo > open_from).then(|| time.clone().lt(at(lo, &tz)));
            let after = (hi < open_to).then(|| time.clone().gt_eq(at(hi, &tz)));
            match (before, after) {
                (Some(b), Some(a)) => Some(b.or(a)),
                (b, a) => b.or(a),
            }
        })
        .reduce(Expr::and)
        .unwrap_or_else(|| datafusion::prelude::lit(false));
    let input = mark_routed(a.input.as_ref().clone())?;
    let raw = LogicalPlan::Aggregate(Aggregate::try_new(
        Arc::new(LogicalPlan::Filter(Filter::try_new(outside, Arc::new(input))?)),
        a.group_expr.clone(),
        a.aggr_expr.clone(),
    )?);

    // Rollup side: its rows in those buckets, as the aggregate's columns.
    let rollup = &candidate.rollup;
    let reference = TableReference::partial(rollup.name().namespace(), rollup.name().name());
    let source = provider_as_source(Arc::new(TimelakeProvider::data(rollup.clone())));
    let bucket_tz = match rollup.schema().field_with_name(&candidate.def.bucket)?.data_type() {
        DataType::Timestamp(_, tz) => tz.clone(),
        _ => tz.clone(),
    };
    let bucket = ident(&candidate.def.bucket);
    let inside = from_rollup
        .iter()
        .map(|&(lo, hi)| {
            let from = (lo > open_from).then(|| bucket.clone().gt_eq(at(lo, &bucket_tz)));
            let to = (hi < open_to).then(|| bucket.clone().lt(at(hi, &bucket_tz)));
            match (from, to) {
                (Some(f), Some(t)) => f.and(t),
                (f, t) => f.or(t).unwrap_or_else(|| datafusion::prelude::lit(true)),
            }
        })
        .reduce(Expr::or)
        .expect("ranges");
    let mut builder = LogicalPlanBuilder::scan(reference, source, None)?.filter(inside)?;
    for f in &q.key_filters {
        builder = builder.filter(unqualified((*f).clone())?)?;
    }
    let scan_schema = builder.schema().clone();
    let n_group = a.group_expr.len();
    let mut exprs = vec![];
    for (i, (qualifier, field)) in a.schema.iter().enumerate() {
        let column = if i < n_group {
            match unalias(&a.group_expr[i]) {
                Expr::Column(c) => c.name.clone(),
                _ => candidate.def.bucket.clone(),
            }
        } else {
            columns[i - n_group].clone()
        };
        let mut e = ident(&column);
        if e.get_type(&scan_schema)? != *field.data_type() {
            e = e.cast_to(field.data_type(), &scan_schema)?;
        }
        exprs.push(e.alias_qualified(qualifier.cloned(), field.name()));
    }
    let from_rollup_plan = builder.project(exprs)?.build()?;

    let union = LogicalPlan::Union(Union::try_new_with_loose_types(vec![Arc::new(raw), Arc::new(from_rollup_plan)])?);
    // A union's columns have no qualifier: give them the aggregate's back for the plan above.
    let names: Vec<Expr> = union
        .schema()
        .fields()
        .iter()
        .zip(a.schema.iter())
        .map(|(f, (qualifier, original))| {
            Expr::Column(Column::new_unqualified(f.name())).alias_qualified(qualifier.cloned(), original.name())
        })
        .collect();
    Ok(LogicalPlan::Projection(Projection::try_new_with_schema(names, Arc::new(union), a.schema.clone())?))
}

/// `plan` with its Timelake scan marked as routed, so the rule leaves it alone from now on.
fn mark_routed(plan: LogicalPlan) -> DfResult<LogicalPlan> {
    plan.transform_up(|node| {
        let LogicalPlan::TableScan(scan) = &node else { return Ok(Transformed::no(node)) };
        let provider = source_as_provider(&scan.source)?;
        let Some(p) = (provider.as_ref() as &dyn Any).downcast_ref::<TimelakeProvider>() else {
            return Ok(Transformed::no(node));
        };
        let mut scan = scan.clone();
        scan.source = provider_as_source(Arc::new(p.routed()));
        Ok(Transformed::yes(LogicalPlan::TableScan(scan)))
    })
    .map(|t| t.data)
}

/// `e` with its columns unqualified, to apply to the rollup's rows.
fn unqualified(e: Expr) -> DfResult<Expr> {
    e.transform(|e| match e {
        Expr::Column(c) => Ok(Transformed::yes(Expr::Column(Column::new_unqualified(c.name)))),
        other => Ok(Transformed::no(other)),
    })
    .map(|t| t.data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complement_and_full_buckets() {
        assert_eq!(complement(&[(10, 20), (30, 40)], 0, 50), vec![(0, 10), (20, 30), (40, 50)]);
        assert_eq!(complement(&[(0, 60)], 0, 60), vec![]);
        assert_eq!(complement(&[], 5, 10), vec![(5, 10)]);
        // [30, 179] holds the 60-wide buckets at 60 and 120 whole; [30, 178] only the one at 60.
        assert_eq!(full_buckets(30, 179, 60), Some((60, 180)));
        assert_eq!(full_buckets(30, 178, 60), Some((60, 120)));
        assert_eq!(full_buckets(60, 119, 60), Some((60, 120)));
        assert_eq!(full_buckets(61, 119, 60), None);
        assert_eq!(ceil(61, 60), 120);
    }

    #[test]
    fn time_comparisons_bound_the_time_column() {
        let t = || ident("time");
        let us = |v: i64| Expr::Literal(ScalarValue::TimestampMicrosecond(Some(v), None), None);
        let ns = |v: i64| Expr::Literal(ScalarValue::TimestampNanosecond(Some(v), None), None);
        assert_eq!(time_bounds(&t().gt_eq(us(5)), "time"), Some((5, i64::MAX)));
        assert_eq!(time_bounds(&t().gt(us(5)), "time"), Some((6, i64::MAX)));
        assert_eq!(time_bounds(&us(5).gt(t()), "time"), Some((i64::MIN, 4)));
        assert_eq!(time_bounds(&t().lt(ns(5_500)), "time"), Some((i64::MIN, 5)));
        assert_eq!(time_bounds(&t().lt_eq(ns(5_500)), "time"), Some((i64::MIN, 5)));
        assert_eq!(time_bounds(&t().gt(ns(5_500)), "time"), Some((6, i64::MAX)));
        assert_eq!(time_bounds(&t().gt_eq(ns(5_500)), "time"), Some((6, i64::MAX)));
        assert_eq!(time_bounds(&t().not_eq(us(5)), "time"), None);
        assert_eq!(time_bounds(&ident("value").gt(us(5)), "time"), None);
    }
}
