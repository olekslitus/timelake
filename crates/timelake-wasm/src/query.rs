//! A query's result, collected file by file.

use arrow_array::RecordBatch;

use crate::aggregate::Aggregator;
use crate::error::{Error, Result};
use crate::file::FileReader;
use crate::filter::filter;
use crate::latest::LatestRows;
use crate::output::rows_json;
use crate::spec::QuerySpec;

/// Collects a query's result across files: rows, time-bucket aggregates (`spec.bucket`), or the
/// newest row per series (`spec.latest_by`).
#[derive(Debug)]
pub struct Collector {
    spec: QuerySpec,
    state: State,
}

#[derive(Debug)]
enum State {
    Rows(Vec<RecordBatch>),
    Buckets(Aggregator),
    Latest(LatestRows),
}

impl Collector {
    pub fn new(spec: QuerySpec) -> Result<Self> {
        let time_column =
            || spec.time_column.clone().ok_or_else(|| Error::invalid("bucket and latest queries need a time column"));
        let state = match (&spec.bucket, &spec.latest_by) {
            (Some(_), Some(_)) => return Err(Error::invalid("a query can't both bucket and pick the latest rows")),
            (Some(bucket), None) => State::Buckets(Aggregator::new(bucket.clone(), time_column()?)?),
            (None, Some(key)) => State::Latest(LatestRows::new(time_column()?, key.clone())),
            (None, None) => State::Rows(vec![]),
        };
        Ok(Self { spec, state })
    }

    pub fn spec(&self) -> &QuerySpec {
        &self.spec
    }

    /// Decodes the planned ranges of `file` and adds its matching rows.
    pub fn push(&mut self, file: &FileReader) -> Result<()> {
        for batch in file.read(&self.spec)? {
            match &mut self.state {
                State::Rows(rows) => rows.push(batch),
                State::Buckets(agg) => agg.push(&batch)?,
                State::Latest(latest) => latest.push(&batch)?,
            }
        }
        Ok(())
    }

    /// Adds the matching rows of a batch already in memory (the last-value index from a head).
    pub fn push_batch(&mut self, batch: &RecordBatch) -> Result<()> {
        let batch = filter(batch, &self.spec)?;
        match &mut self.state {
            State::Rows(rows) => rows.push(batch),
            State::Buckets(agg) => agg.push(&batch)?,
            State::Latest(latest) => latest.push(&batch)?,
        }
        Ok(())
    }

    /// The result as a JSON array of objects.
    pub fn finish(&self) -> Result<String> {
        match &self.state {
            State::Rows(rows) => rows_json(rows, &self.spec),
            State::Buckets(agg) => agg.finish(),
            State::Latest(latest) => rows_json(latest.rows(), &self.spec),
        }
    }
}
