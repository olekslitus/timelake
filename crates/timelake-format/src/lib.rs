//! Timelake's on-disk conventions, with no I/O and no heavy dependencies, so the engine
//! (`timelake`) and the WebAssembly reader (`timelake-wasm`) share one definition: the table
//! contract stored in `timelake.*` properties, time partition math, and Iceberg bound decoding.

pub mod bounds;
pub mod contract;

pub use contract::{Chunk, Contract, TableOptions, parse_duration};

/// Errors from parsing Timelake conventions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormatError(pub String);

impl std::fmt::Display for FormatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for FormatError {}

pub type Result<T> = std::result::Result<T, FormatError>;

/// Snapshot summary key holding the last-value index location of that snapshot.
pub const S_LVI: &str = "timelake.last-value-index";
/// Snapshot summary key holding the writer-supplied idempotency key of an append.
pub const S_BATCH_ID: &str = "timelake.batch-id";
/// Optional warehouse-level index of table names, for stores that cannot list (plain HTTPS).
pub const TABLES_INDEX: &str = "timelake-tables.json";
