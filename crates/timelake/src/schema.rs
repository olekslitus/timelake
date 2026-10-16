//! Mapping Arrow data onto a table's schema: on create (types Iceberg can store) and on write
//! (incoming batches cast and reordered to the table schema).

use arrow::array::{ArrayRef, RecordBatch, new_null_array};
use arrow::compute::cast;
use arrow::datatypes::{DataType, Field, Schema, SchemaRef, TimeUnit};

use crate::error::{Error, Result};

/// The time zone timestamps with any zone are stored in.
pub(crate) const UTC: &str = "+00:00";

/// Maps Arrow types to ones with a lossless Iceberg equivalent: any timestamp → microseconds,
/// small ints → int, dictionaries → their value type, large/view strings → strings. The time
/// column is made NOT NULL, and a text time column (CSV, JSON) becomes a UTC timestamp.
pub(crate) fn normalize_schema(schema: &Schema, time_column: Option<&str>) -> Result<Schema> {
    let fields = schema
        .fields()
        .iter()
        .map(|f| {
            let is_time = Some(f.name().as_str()) == time_column;
            let data_type = match normalize_type(f.data_type())? {
                DataType::Utf8 if is_time => DataType::Timestamp(TimeUnit::Microsecond, Some(UTC.into())),
                dt => dt,
            };
            Ok(Field::new(f.name(), data_type, f.is_nullable() && !is_time))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Schema::new(fields))
}

fn normalize_type(dt: &DataType) -> Result<DataType> {
    Ok(match dt {
        DataType::Int8 | DataType::Int16 | DataType::UInt8 | DataType::UInt16 => DataType::Int32,
        DataType::UInt32 => DataType::Int64,
        DataType::Float16 => DataType::Float32,
        DataType::Timestamp(_, tz) => DataType::Timestamp(TimeUnit::Microsecond, tz.as_ref().map(|_| UTC.into())),
        DataType::Date64 => DataType::Date32,
        DataType::Dictionary(_, v) => normalize_type(v)?,
        DataType::LargeUtf8 | DataType::Utf8View => DataType::Utf8,
        DataType::LargeBinary | DataType::BinaryView => DataType::Binary,
        DataType::UInt64 => return Err(Error::invalid("UInt64 columns are not supported by Iceberg; cast to Int64")),
        other => other.clone(),
    })
}

/// Casts and reorders a batch to the table schema by column name. Missing nullable columns are
/// filled with nulls; extra columns are an error (add them to the schema first).
pub fn align_batch(batch: &RecordBatch, schema: &SchemaRef) -> Result<RecordBatch> {
    let input = batch.schema();
    if let Some(extra) = input.fields().iter().find(|f| schema.field_with_name(f.name()).is_err()) {
        return Err(Error::invalid(format!("column {:?} is not in the table schema", extra.name())));
    }
    let columns = schema
        .fields()
        .iter()
        .map(|f| match input.index_of(f.name()) {
            Ok(i) if batch.column(i).data_type() == f.data_type() => Ok(batch.column(i).clone()),
            Ok(i) => Ok(cast(batch.column(i), f.data_type())?),
            Err(_) if f.is_nullable() => Ok(new_null_array(f.data_type(), batch.num_rows())),
            Err(_) => Err(Error::invalid(format!("required column {:?} is missing", f.name()))),
        })
        .collect::<Result<Vec<ArrayRef>>>()?;
    RecordBatch::try_new(schema.clone(), columns)
        .map_err(|e| Error::invalid(format!("batch does not fit the table schema: {e}")))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use arrow::array::{Array, Int8Array, Int32Array, StringArray};

    use super::*;

    #[test]
    fn normalizes_types_iceberg_cannot_store() {
        let schema = Schema::new(vec![
            Field::new("t", DataType::Timestamp(TimeUnit::Nanosecond, Some("Europe/Kyiv".into())), true),
            Field::new("local", DataType::Timestamp(TimeUnit::Millisecond, None), true),
            Field::new("small", DataType::UInt8, false),
            Field::new("u32", DataType::UInt32, true),
            Field::new("tag", DataType::Dictionary(Box::new(DataType::Int8), Box::new(DataType::LargeUtf8)), true),
            Field::new("day", DataType::Date64, true),
        ]);
        let n = normalize_schema(&schema, Some("t")).unwrap();
        let types: Vec<_> = n.fields().iter().map(|f| f.data_type().clone()).collect();
        assert_eq!(
            types,
            [
                DataType::Timestamp(TimeUnit::Microsecond, Some(UTC.into())),
                DataType::Timestamp(TimeUnit::Microsecond, None),
                DataType::Int32,
                DataType::Int64,
                DataType::Utf8,
                DataType::Date32,
            ]
        );
        // The time column is required; other columns keep their nullability.
        assert!(!n.field(0).is_nullable() && !n.field(2).is_nullable() && n.field(3).is_nullable());
    }

    #[test]
    fn text_time_column_becomes_a_timestamp() {
        let schema = Schema::new(vec![Field::new("time", DataType::Utf8, true), Field::new("s", DataType::Utf8, true)]);
        let n = normalize_schema(&schema, Some("time")).unwrap();
        assert_eq!(n.field(0).data_type(), &DataType::Timestamp(TimeUnit::Microsecond, Some(UTC.into())));
        assert_eq!(n.field(1).data_type(), &DataType::Utf8);
    }

    #[test]
    fn rejects_uint64() {
        let schema = Schema::new(vec![Field::new("n", DataType::UInt64, true)]);
        assert!(normalize_schema(&schema, None).is_err());
    }

    fn table_schema() -> SchemaRef {
        Arc::new(Schema::new(vec![Field::new("id", DataType::Int32, false), Field::new("name", DataType::Utf8, true)]))
    }

    #[test]
    fn aligns_by_name_and_casts() {
        let input = Arc::new(Schema::new(vec![Field::new("id", DataType::Int8, false)]));
        let batch = RecordBatch::try_new(input, vec![Arc::new(Int8Array::from(vec![1, 2]))]).unwrap();
        let aligned = align_batch(&batch, &table_schema()).unwrap();
        assert_eq!(aligned.schema(), table_schema());
        assert_eq!(aligned.column(0).as_any().downcast_ref::<Int32Array>().unwrap().values(), &[1, 2]);
        assert_eq!(aligned.column(1).null_count(), 2);

        let reordered = RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("name", DataType::Utf8, true),
                Field::new("id", DataType::Int32, false),
            ])),
            vec![Arc::new(StringArray::from(vec!["a"])), Arc::new(Int32Array::from(vec![7]))],
        )
        .unwrap();
        let aligned = align_batch(&reordered, &table_schema()).unwrap();
        assert_eq!(aligned.column(0).as_any().downcast_ref::<Int32Array>().unwrap().value(0), 7);
    }

    #[test]
    fn rejects_extra_and_missing_required_columns() {
        let extra = RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("id", DataType::Int32, false),
                Field::new("x", DataType::Int32, true),
            ])),
            vec![Arc::new(Int32Array::from(vec![1])), Arc::new(Int32Array::from(vec![1]))],
        )
        .unwrap();
        assert!(align_batch(&extra, &table_schema()).is_err());

        let missing = RecordBatch::try_new(
            Arc::new(Schema::new(vec![Field::new("name", DataType::Utf8, true)])),
            vec![Arc::new(StringArray::from(vec!["a"]))],
        )
        .unwrap();
        assert!(align_batch(&missing, &table_schema()).is_err());
    }
}
