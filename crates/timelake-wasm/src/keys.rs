//! Group keys: the values of some columns encoded as bytes (Arrow's row format), so grouping
//! hashes or orders one byte string per row instead of allocating a value per column.

use arrow_array::{ArrayRef, RecordBatch};
use arrow_cast::cast;
use arrow_row::{RowConverter, Rows, SortField};
use arrow_schema::DataType;

use crate::error::{Error, Result};

#[derive(Debug)]
pub(crate) struct KeyEncoder {
    columns: Vec<String>,
    /// Made from the first batch's column types; later batches are cast to them, since files
    /// may store a column with a different (compatible) type.
    converter: Option<(RowConverter, Vec<DataType>)>,
}

impl KeyEncoder {
    pub(crate) fn new(columns: Vec<String>) -> Self {
        Self { columns, converter: None }
    }

    /// The keys of every row of `batch`, or `None` when there are no key columns (every row has
    /// the same, empty key). Encoded keys order like the values, nulls first.
    pub(crate) fn encode(&mut self, batch: &RecordBatch) -> Result<Option<Rows>> {
        if self.columns.is_empty() {
            return Ok(None);
        }
        let mut arrays: Vec<ArrayRef> = self
            .columns
            .iter()
            .map(|c| batch.column_by_name(c).cloned().ok_or_else(|| Error::invalid(format!("unknown column {c}"))))
            .collect::<Result<_>>()?;
        let (converter, types) = if let Some(converter) = &self.converter {
            converter
        } else {
            let types: Vec<DataType> = arrays.iter().map(|a| a.data_type().clone()).collect();
            let converter = RowConverter::new(types.iter().cloned().map(SortField::new).collect())?;
            &*self.converter.insert((converter, types))
        };
        for (array, ty) in arrays.iter_mut().zip(types.iter()) {
            if array.data_type() != ty {
                *array = cast(array, ty)?;
            }
        }
        Ok(Some(converter.convert_columns(&arrays)?))
    }

    /// Decodes keys made by [`encode`](Self::encode) back into one array per key column.
    pub(crate) fn decode<'a>(&self, keys: impl IntoIterator<Item = &'a [u8]>) -> Result<Vec<ArrayRef>> {
        let Some((converter, _)) = &self.converter else { return Ok(vec![]) };
        let parser = converter.parser();
        Ok(converter.convert_rows(keys.into_iter().map(|k| parser.parse(k)))?)
    }
}
