//! Query results as JSON.

use arrow_array::RecordBatch;
use arrow_json::writer::JsonArray;
use arrow_ord::sort::{SortOptions, sort_to_indices};
use arrow_select::concat::concat_batches;
use arrow_select::take::take_record_batch;

use crate::error::{Error, Result};
use crate::spec::QuerySpec;

/// RFC 3339 in UTC, like the engine's JSON output (`2026-01-03T23:00:00Z`).
pub(crate) fn iso(micros: i64) -> String {
    chrono::DateTime::from_timestamp_micros(micros)
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true))
        .unwrap_or_default()
}

/// A batch as a JSON array of objects, with nulls written out.
pub(crate) fn to_json(batch: &RecordBatch) -> Result<String> {
    let mut buf = vec![];
    let mut writer = arrow_json::WriterBuilder::new().with_explicit_nulls(true).build::<_, JsonArray>(&mut buf);
    writer.write(batch)?;
    writer.finish()?;
    drop(writer);
    String::from_utf8(buf).map_err(|e| Error::invalid(e.to_string()))
}

/// Rows ordered by time, limited and projected as the query asks, as JSON.
pub(crate) fn rows_json(batches: &[RecordBatch], spec: &QuerySpec) -> Result<String> {
    let Some(first) = batches.first() else { return Ok("[]".into()) };
    let all = concat_batches(&first.schema(), batches)?;
    let sorted = match spec.time_column.as_ref().and_then(|tc| all.column_by_name(tc)) {
        Some(time) => {
            let options = SortOptions { descending: spec.descending, nulls_first: false };
            take_record_batch(&all, &sort_to_indices(time, Some(options), spec.limit)?)?
        }
        None => all,
    };
    let limited = match spec.limit {
        Some(n) if n < sorted.num_rows() => sorted.slice(0, n),
        _ => sorted,
    };
    let projected = if spec.columns.is_empty() {
        limited
    } else {
        let schema = limited.schema();
        let indices: Vec<usize> = spec.columns.iter().filter_map(|c| schema.index_of(c).ok()).collect();
        limited.project(&indices)?
    };
    to_json(&projected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_times_like_the_engine() {
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso(1_767_225_600_000_000), "2026-01-01T00:00:00Z");
        assert_eq!(iso(1_500), "1970-01-01T00:00:00.001500Z");
        assert_eq!(iso(-1_000_000), "1969-12-31T23:59:59Z");
    }
}
