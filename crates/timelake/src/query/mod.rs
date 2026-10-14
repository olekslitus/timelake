//! The Timelake reader: DataFusion over Timelake tables.
//!
//! What it adds over a generic Iceberg/Parquet scan (SPEC §12.2):
//! - **File pruning** on Iceberg column bounds (time range, series key) evaluated with DataFusion's
//!   `PruningPredicate`, then row-group and page pruning inside the (sorted) Parquet files.
//! - **Last-value rewrite:** "newest row per series" queries (`ROW_NUMBER() OVER (PARTITION BY
//!   <series key> ORDER BY <time> DESC) = 1`) and "newest row" queries (`ORDER BY <time> DESC
//!   LIMIT 1` filtered on the series key) are answered from the last-value index instead of a scan.
//! - `time_bucket(interval, ts [, origin])` as in `TimescaleDB`.
//! - Namespaces as SQL schemas: `SELECT … FROM iot.readings`.

mod catalog;
mod provider;
mod rewrite;
mod session;
mod stats;

pub use session::Session;

/// Name of the lake's catalog in SQL.
const CATALOG: &str = "timelake";

/// How long a table version loaded for planning is reused by later planning in this process.
/// Commits made by this process are visible immediately regardless.
const PLAN_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(1);
