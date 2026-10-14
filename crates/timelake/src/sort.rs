//! Sorting rows by key columns with input order as the tiebreak, and keeping the last row of each
//! group of equal keys. Writes, compaction and the last-value index all rely on "later input row
//! wins" among rows with the same `(series…, time)`.

use std::sync::Arc;

use arrow::array::{ArrayRef, RecordBatch, UInt32Array};
use arrow::compute::{SortColumn, SortOptions, lexsort_to_indices, partition, take_record_batch};

use crate::error::{Error, Result};

/// Ascending with nulls first: the order Timelake writes and declares for `(series…, time)`.
pub(crate) const ASCENDING: SortOptions = SortOptions { descending: false, nulls_first: true };

/// The columns of `batch` named `names`, in that order.
pub(crate) fn columns(batch: &RecordBatch, names: &[String]) -> Result<Vec<ArrayRef>> {
    let schema = batch.schema();
    names.iter().map(|n| Ok(batch.column(schema.index_of(n)?).clone())).collect()
}

/// Row indices that sort by `keys` (ascending, nulls first), keeping input order among equal keys.
pub(crate) fn stable_sort_indices(keys: &[ArrayRef], rows: usize) -> Result<UInt32Array> {
    let rows = u32::try_from(rows).map_err(|_| too_many_rows(rows))?;
    let mut columns: Vec<SortColumn> =
        keys.iter().map(|k| SortColumn { values: k.clone(), options: Some(ASCENDING) }).collect();
    columns.push(SortColumn { values: Arc::new(UInt32Array::from_iter_values(0..rows)), options: None });
    Ok(lexsort_to_indices(&columns, None)?)
}

/// `batch` sorted by its columns `names`, keeping input order among equal keys.
pub(crate) fn stable_sort(batch: &RecordBatch, names: &[String]) -> Result<RecordBatch> {
    if names.is_empty() || batch.num_rows() == 0 {
        return Ok(batch.clone());
    }
    let indices = stable_sort_indices(&columns(batch, names)?, batch.num_rows())?;
    Ok(take_record_batch(batch, &indices)?)
}

/// The last row of each run of equal values in the columns `names` of a sorted batch (the last
/// row overall if `names` is empty).
pub(crate) fn last_per_group(sorted: &RecordBatch, names: &[String]) -> Result<RecordBatch> {
    let rows = sorted.num_rows();
    if rows == 0 {
        return Ok(sorted.clone());
    }
    if names.is_empty() {
        return Ok(sorted.slice(rows - 1, 1));
    }
    let groups = partition(&columns(sorted, names)?)?.ranges();
    if groups.len() == rows {
        return Ok(sorted.clone());
    }
    let last: UInt32Array =
        groups.iter().map(|g| u32::try_from(g.end - 1)).collect::<Result<_, _>>().map_err(|_| too_many_rows(rows))?;
    Ok(take_record_batch(sorted, &last)?)
}

fn too_many_rows(rows: usize) -> Error {
    Error::invalid(format!("{rows} rows are too many to sort at once"))
}

#[cfg(test)]
mod tests {
    use arrow::array::{Array, Int32Array, StringArray};
    use arrow::datatypes::{DataType, Field, Schema};

    use super::*;

    fn batch(keys: &[Option<i32>], tags: &[&str]) -> RecordBatch {
        let schema =
            Schema::new(vec![Field::new("k", DataType::Int32, true), Field::new("tag", DataType::Utf8, false)]);
        RecordBatch::try_new(
            Arc::new(schema),
            vec![Arc::new(Int32Array::from(keys.to_vec())), Arc::new(StringArray::from(tags.to_vec()))],
        )
        .unwrap()
    }

    fn tags(b: &RecordBatch) -> Vec<&str> {
        let tags = b.column(1).as_any().downcast_ref::<StringArray>().unwrap();
        (0..tags.len()).map(|i| tags.value(i)).collect()
    }

    #[test]
    fn sorts_nulls_first_and_keeps_input_order_on_ties() {
        let b = batch(&[Some(2), None, Some(1), Some(2), Some(1)], &["a", "b", "c", "d", "e"]);
        let sorted = stable_sort(&b, &["k".into()]).unwrap();
        assert_eq!(tags(&sorted), ["b", "c", "e", "a", "d"]);
        assert_eq!(tags(&last_per_group(&sorted, &["k".into()]).unwrap()), ["b", "e", "d"]);
    }

    #[test]
    fn without_keys_keeps_the_last_row() {
        let b = batch(&[Some(1), Some(2)], &["a", "b"]);
        assert_eq!(tags(&stable_sort(&b, &[]).unwrap()), ["a", "b"]);
        assert_eq!(tags(&last_per_group(&b, &[]).unwrap()), ["b"]);
    }

    #[test]
    fn empty_input() {
        let b = batch(&[], &[]);
        assert_eq!(last_per_group(&stable_sort(&b, &["k".into()]).unwrap(), &["k".into()]).unwrap().num_rows(), 0);
    }
}
