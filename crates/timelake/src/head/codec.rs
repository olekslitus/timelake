//! How a head is encoded. The content is format-neutral, a [`HeadDoc`]: string properties plus
//! named Arrow tables. A [`HeadCodec`] turns it into bytes and back, and every head records the
//! name of the codec that wrote it, so the format is a per-table setting
//! (`timelake.head-format`) and readers decode any head written by a codec they know.
//!
//! Built in: `arrow` (Arrow IPC streams, zstd-compressed; the default) and `json` (readable, for
//! debugging and tools without Arrow). Any format with an Arrow bridge (Avro, Vortex, BSON,
//! Parquet, …) fits the same trait: implement it and add it with
//! [`Lake::register_head_codec`](crate::Lake::register_head_codec).

use std::collections::{BTreeMap, HashMap};
use std::fmt::Debug;
use std::io::Cursor;
use std::sync::{Arc, PoisonError, RwLock};

use arrow::array::{RecordBatch, RecordBatchOptions};
use arrow::compute::concat_batches;
use arrow::datatypes::{Schema, SchemaRef};
use arrow::ipc::CompressionType;
use arrow::ipc::reader::StreamReader;
use arrow::ipc::writer::{IpcWriteOptions, StreamWriter};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// The content of a head, independent of its encoding.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HeadDoc {
    /// Scalar fields.
    pub properties: BTreeMap<String, String>,
    /// Named tables.
    pub sections: BTreeMap<String, RecordBatch>,
}

/// Encodes a [`HeadDoc`] to bytes and back.
pub trait HeadCodec: Send + Sync + Debug {
    /// The name stored in every head this codec writes, and the `timelake.head-format` value that
    /// selects it: lowercase ASCII, at most 255 bytes.
    fn name(&self) -> &str;

    /// Encodes a document.
    fn encode(&self, doc: &HeadDoc) -> Result<Vec<u8>>;

    /// Decodes what [`HeadCodec::encode`] wrote.
    fn decode(&self, bytes: &[u8]) -> Result<HeadDoc>;
}

/// The codecs a lake can read and write heads with, by name.
#[derive(Debug)]
pub(crate) struct Codecs(RwLock<HashMap<String, Arc<dyn HeadCodec>>>);

impl Default for Codecs {
    fn default() -> Self {
        let codecs = Self(RwLock::default());
        codecs.register(Arc::new(ArrowCodec));
        codecs.register(Arc::new(JsonCodec));
        codecs
    }
}

impl Codecs {
    pub(crate) fn register(&self, codec: Arc<dyn HeadCodec>) {
        let name = codec.name().to_string();
        self.0.write().unwrap_or_else(PoisonError::into_inner).insert(name, codec);
    }

    pub(crate) fn get(&self, name: &str) -> Option<Arc<dyn HeadCodec>> {
        self.0.read().unwrap_or_else(PoisonError::into_inner).get(name).cloned()
    }
}

/// Schema metadata key holding a section's name in the `arrow` codec.
const SECTION_KEY: &str = "timelake.section";

/// Arrow IPC: one stream for the properties (as schema metadata), then one stream per section,
/// each prefixed with its length. Buffers are zstd-compressed.
#[derive(Clone, Copy, Debug, Default)]
pub struct ArrowCodec;

impl HeadCodec for ArrowCodec {
    fn name(&self) -> &'static str {
        "arrow"
    }

    fn encode(&self, doc: &HeadDoc) -> Result<Vec<u8>> {
        let options = IpcWriteOptions::default().try_with_compression(Some(CompressionType::ZSTD))?;
        let mut out = vec![];
        let properties = Schema::empty().with_metadata(doc.properties.clone().into_iter().collect());
        write_stream(&mut out, &properties, None, &options)?;
        for (name, batch) in &doc.sections {
            let mut metadata = batch.schema().metadata().clone();
            metadata.insert(SECTION_KEY.into(), name.clone());
            let schema = Arc::new(batch.schema().as_ref().clone().with_metadata(metadata));
            write_stream(&mut out, &schema, Some(&with_schema(batch, &schema)?), &options)?;
        }
        Ok(out)
    }

    fn decode(&self, mut bytes: &[u8]) -> Result<HeadDoc> {
        let mut doc = HeadDoc::default();
        let mut first = true;
        while !bytes.is_empty() {
            let (stream, rest) = next_stream(bytes)?;
            bytes = rest;
            let reader = StreamReader::try_new(Cursor::new(stream), None)?;
            let mut schema = reader.schema().as_ref().clone();
            if first {
                doc.properties = schema.metadata.into_iter().collect();
                first = false;
                continue;
            }
            let name =
                schema.metadata.remove(SECTION_KEY).ok_or_else(|| Error::invalid("head section without name"))?;
            let schema = Arc::new(schema);
            let batches = reader.map(|b| with_schema(&b?, &schema)).collect::<Result<Vec<_>>>()?;
            doc.sections.insert(name, concat_batches(&schema, &batches)?);
        }
        Ok(doc)
    }
}

/// `batch` with `schema`, which differs from its own only in metadata.
fn with_schema(batch: &RecordBatch, schema: &SchemaRef) -> Result<RecordBatch> {
    let options = RecordBatchOptions::new().with_row_count(Some(batch.num_rows()));
    Ok(RecordBatch::try_new_with_options(schema.clone(), batch.columns().to_vec(), &options)?)
}

fn write_stream(
    out: &mut Vec<u8>,
    schema: &Schema,
    batch: Option<&RecordBatch>,
    options: &IpcWriteOptions,
) -> Result<()> {
    let mut buf = vec![];
    let mut w = StreamWriter::try_new_with_options(&mut buf, schema, options.clone())?;
    if let Some(batch) = batch {
        w.write(batch)?;
    }
    w.finish()?;
    drop(w);
    out.extend_from_slice(&(buf.len() as u64).to_le_bytes());
    out.extend_from_slice(&buf);
    Ok(())
}

/// Splits off the next length-prefixed stream.
fn next_stream(bytes: &[u8]) -> Result<(&[u8], &[u8])> {
    let truncated = || Error::invalid("truncated head");
    let (len, rest) = bytes.split_first_chunk::<8>().ok_or_else(truncated)?;
    let len = usize::try_from(u64::from_le_bytes(*len)).map_err(|_| truncated())?;
    if rest.len() < len {
        return Err(truncated());
    }
    Ok(rest.split_at(len))
}

/// JSON: `{"properties": {…}, "sections": [{"name", "schema", "rows": [{…}]}]}`. Rows are Arrow's
/// JSON form (binary as hex, timestamps as ISO 8601), schemas are `arrow-schema`'s serde form.
#[derive(Clone, Copy, Debug, Default)]
pub struct JsonCodec;

#[derive(Serialize, Deserialize)]
struct JsonDoc {
    properties: BTreeMap<String, String>,
    sections: Vec<JsonSection>,
}

#[derive(Serialize, Deserialize)]
struct JsonSection {
    name: String,
    schema: Schema,
    rows: Vec<serde_json::Value>,
}

impl HeadCodec for JsonCodec {
    fn name(&self) -> &'static str {
        "json"
    }

    fn encode(&self, doc: &HeadDoc) -> Result<Vec<u8>> {
        let sections = doc
            .sections
            .iter()
            .map(|(name, batch)| {
                let mut w = arrow::json::WriterBuilder::new()
                    .with_explicit_nulls(true)
                    .build::<_, arrow::json::writer::JsonArray>(vec![]);
                w.write(batch)?;
                w.finish()?;
                let rows = serde_json::from_slice(&w.into_inner())?;
                Ok(JsonSection { name: name.clone(), schema: batch.schema().as_ref().clone(), rows })
            })
            .collect::<Result<_>>()?;
        Ok(serde_json::to_vec(&JsonDoc { properties: doc.properties.clone(), sections })?)
    }

    fn decode(&self, bytes: &[u8]) -> Result<HeadDoc> {
        let json: JsonDoc = serde_json::from_slice(bytes)?;
        let mut doc = HeadDoc { properties: json.properties, sections: BTreeMap::new() };
        for section in json.sections {
            let schema = Arc::new(section.schema);
            let mut decoder = arrow::json::ReaderBuilder::new(schema.clone())
                .with_batch_size(section.rows.len().max(1))
                .build_decoder()?;
            decoder.serialize(&section.rows)?;
            let batch = decoder.flush()?.unwrap_or_else(|| RecordBatch::new_empty(schema));
            doc.sections.insert(section.name, batch);
        }
        Ok(doc)
    }
}

#[cfg(test)]
mod tests {
    use arrow::array::{BinaryArray, Int64Array, StringArray, TimestampMicrosecondArray};
    use arrow::datatypes::{DataType, Field, TimeUnit};

    use super::*;

    fn doc() -> HeadDoc {
        let schema = Arc::new(Schema::new(vec![
            Field::new("path", DataType::Utf8, false),
            Field::new("n", DataType::Int64, true),
            Field::new("bytes", DataType::Binary, true),
            Field::new("time", DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())), false)
                .with_metadata(HashMap::from([("PARQUET:field_id".into(), "4".into())])),
        ]));
        let batch = RecordBatch::try_new(
            schema,
            vec![
                Arc::new(StringArray::from(vec!["a", "b"])),
                Arc::new(Int64Array::from(vec![Some(1), None])),
                Arc::new(BinaryArray::from(vec![Some(b"\x00\xff".as_slice()), None])),
                Arc::new(TimestampMicrosecondArray::from(vec![1, 2]).with_timezone("UTC")),
            ],
        )
        .unwrap();
        let empty = RecordBatch::new_empty(Arc::new(Schema::new(vec![Field::new("x", DataType::Utf8, true)])));
        HeadDoc {
            properties: BTreeMap::from([("k".into(), "v".into())]),
            sections: BTreeMap::from([("files".into(), batch), ("empty".into(), empty)]),
        }
    }

    #[test]
    fn built_in_codecs_round_trip() {
        for codec in [&ArrowCodec as &dyn HeadCodec, &JsonCodec] {
            let doc = doc();
            assert_eq!(codec.decode(&codec.encode(&doc).unwrap()).unwrap(), doc, "{}", codec.name());
        }
    }

    #[test]
    fn truncated_input_is_an_error() {
        let bytes = ArrowCodec.encode(&doc()).unwrap();
        assert!(ArrowCodec.decode(&bytes[..bytes.len() - 1]).is_err());
        assert!(JsonCodec.decode(b"{").is_err());
    }
}
