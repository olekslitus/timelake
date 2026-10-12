//! Timelake: a serverless time-series lake on Apache Iceberg.
//!
//! ```no_run
//! # async fn demo(batch: arrow::array::RecordBatch) -> timelake::Result<()> {
//! use timelake::{Lake, TableOptions};
//! let lake = Lake::open("s3://bucket/warehouse", Default::default())?;
//! let table = lake
//!     .create_table("iot.readings", &batch.schema(), TableOptions {
//!         time_column: Some("time".into()),
//!         series_key: vec!["device_id".into()],
//!         ..Default::default()
//!     })
//!     .await?;
//! table.append(&[batch], Default::default()).await?;
//! let session = timelake::Session::new(lake);
//! let rows = session.sql("SELECT * FROM iot.readings WHERE device_id = 7").await?.collect().await?;
//! # Ok(()) }
//! ```

mod commit;
pub use timelake_format::{bounds, contract};
mod error;
mod lake;
mod lvi;
mod ops;
pub mod query;
pub mod storage;
mod write;

pub use commit::CommitInfo;
pub use contract::{Chunk, Contract, TableOptions};
pub use error::{Error, Result};
pub use lake::{DEFAULT_NAMESPACE, Lake, LiveEntry, Table, TableName};
pub use lvi::latest_per_series;
pub use ops::{AppendOptions, AppendResult, MaintainOptions, MaintainReport};
pub use query::Session;
pub use write::{align_batch, file_partition};

pub use arrow;
pub use datafusion;
