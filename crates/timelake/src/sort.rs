//! Sorting rows by key columns with input order as the tiebreak, and keeping the last row of each
//! group of equal keys (`timelake_format::rows`, shared with the WASM writer). Writes, compaction
//! and the last-value index all rely on "later input row wins" among rows with the same
//! `(series…, time)`.

use arrow::array::RecordBatch;

use crate::error::Result;

pub(crate) use timelake_format::rows::ASCENDING;

/// `batch` sorted by its columns `names`, keeping input order among equal keys.
pub(crate) fn stable_sort(batch: &RecordBatch, names: &[String]) -> Result<RecordBatch> {
    Ok(timelake_format::rows::stable_sort(batch, names)?)
}
