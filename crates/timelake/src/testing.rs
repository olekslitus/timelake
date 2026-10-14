//! Test support: an in-memory object store that fails chosen operations or adds latency, and table
//! fixtures.

use std::collections::HashMap;
use std::fmt;
use std::ops::Range;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use arrow::array::{Float64Array, Int32Array, RecordBatch, TimestampMicrosecondArray};
use arrow::datatypes::{DataType, Field, Schema, TimeUnit};
use async_trait::async_trait;
use bytes::Bytes;
use futures::StreamExt;
use futures::stream::BoxStream;
use object_store::memory::InMemory;
use object_store::path::Path;
use object_store::{
    CopyOptions, GetOptions, GetResult, ListResult, MultipartUpload, ObjectMeta, ObjectStore, PutMode,
    PutMultipartOptions, PutOptions, PutPayload, PutResult,
};

use crate::commit::{Change, commit};
use crate::storage::{Storage, Uploads};
use crate::write::{sort_and_split, write_partition, writer_properties};
use crate::{Lake, Table, TableOptions};

/// Which operation a [`Fault`] breaks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Op {
    /// Reads (`get`, ranged reads, `head`).
    Get,
    /// Writes of any kind.
    Put,
    /// Put-if-absent reports "already exists", as if another writer won the commit race.
    LoseCreate,
}

/// Fails `op` on every path containing `pattern`.
#[derive(Clone, Debug)]
pub(crate) struct Fault {
    pub op: Op,
    pub pattern: String,
}

/// An in-memory store with switchable faults and latency.
#[derive(Debug, Default)]
pub(crate) struct FaultyStore {
    inner: InMemory,
    faults: Mutex<Vec<Fault>>,
    latency: Mutex<Duration>,
}

impl FaultyStore {
    /// Delays every request by `latency`, like a round trip to a remote store. With Tokio's clock
    /// paused, a test's elapsed time divided by `latency` is the number of requests made one after
    /// another.
    pub(crate) fn set_latency(&self, latency: Duration) {
        *self.latency.lock().unwrap_or_else(PoisonError::into_inner) = latency;
    }

    async fn round_trip(&self) {
        let latency = *self.latency.lock().unwrap_or_else(PoisonError::into_inner);
        if !latency.is_zero() {
            tokio::time::sleep(latency).await;
        }
    }

    pub(crate) fn fail(&self, op: Op, pattern: &str) {
        self.faults().push(Fault { op, pattern: pattern.to_string() });
    }

    pub(crate) fn heal(&self) {
        self.faults().clear();
    }

    /// Every object path in the store.
    pub(crate) async fn paths(&self) -> Vec<String> {
        let mut out: Vec<String> = self.inner.list(None).map(|m| m.unwrap().location.to_string()).collect().await;
        out.sort();
        out
    }

    fn faults(&self) -> std::sync::MutexGuard<'_, Vec<Fault>> {
        self.faults.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn check(&self, op: Op, path: &Path) -> object_store::Result<()> {
        let hit = self.faults().iter().any(|f| f.op == op && path.as_ref().contains(&f.pattern));
        if !hit {
            return Ok(());
        }
        let path = path.to_string();
        Err(match op {
            Op::LoseCreate => object_store::Error::AlreadyExists { path, source: "injected".into() },
            Op::Get | Op::Put => {
                object_store::Error::Generic { store: "faulty", source: format!("{op:?} {path}").into() }
            }
        })
    }
}

impl fmt::Display for FaultyStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("FaultyStore")
    }
}

#[async_trait]
impl ObjectStore for FaultyStore {
    async fn put_opts(
        &self,
        location: &Path,
        payload: PutPayload,
        opts: PutOptions,
    ) -> object_store::Result<PutResult> {
        self.round_trip().await;
        self.check(Op::Put, location)?;
        if opts.mode == PutMode::Create {
            self.check(Op::LoseCreate, location)?;
        }
        self.inner.put_opts(location, payload, opts).await
    }

    async fn put_multipart_opts(
        &self,
        location: &Path,
        opts: PutMultipartOptions,
    ) -> object_store::Result<Box<dyn MultipartUpload>> {
        self.round_trip().await;
        self.check(Op::Put, location)?;
        self.inner.put_multipart_opts(location, opts).await
    }

    async fn get_opts(&self, location: &Path, options: GetOptions) -> object_store::Result<GetResult> {
        self.round_trip().await;
        self.check(Op::Get, location)?;
        self.inner.get_opts(location, options).await
    }

    async fn get_ranges(&self, location: &Path, ranges: &[Range<u64>]) -> object_store::Result<Vec<Bytes>> {
        self.round_trip().await;
        self.check(Op::Get, location)?;
        self.inner.get_ranges(location, ranges).await
    }

    fn delete_stream(
        &self,
        locations: BoxStream<'static, object_store::Result<Path>>,
    ) -> BoxStream<'static, object_store::Result<Path>> {
        self.inner.delete_stream(locations)
    }

    fn list(&self, prefix: Option<&Path>) -> BoxStream<'static, object_store::Result<ObjectMeta>> {
        self.inner.list(prefix)
    }

    async fn list_with_delimiter(&self, prefix: Option<&Path>) -> object_store::Result<ListResult> {
        self.inner.list_with_delimiter(prefix).await
    }

    async fn copy_opts(&self, from: &Path, to: &Path, options: CopyOptions) -> object_store::Result<()> {
        self.inner.copy_opts(from, to, options).await
    }
}

/// Appends rows the way another Iceberg writer would: without a last-value index.
pub(crate) async fn append_without_index(table: &Table, batches: &[RecordBatch]) -> Table {
    let props = writer_properties(table).unwrap();
    let uploads = Uploads::default();
    let mut files = vec![];
    for (partition, batch) in sort_and_split(table, batches).unwrap() {
        files.extend(write_partition(table, partition, [batch], &props, &uploads).await.unwrap());
    }
    commit(table, Change::Append { files, latest: None }, HashMap::new(), uploads).await.unwrap().0
}

/// A lake on a [`FaultyStore`].
pub(crate) fn faulty_lake() -> (Lake, Arc<FaultyStore>) {
    let store = Arc::new(FaultyStore::default());
    let lake = Lake::with_storage(Storage::from_store(store.clone(), "memory://test"), "memory://test/wh");
    (lake, store)
}

pub(crate) const T0: i64 = 1_767_225_600_000_000; // 2026-01-01T00:00:00Z

pub(crate) fn schema() -> Schema {
    Schema::new(vec![
        Field::new("time", DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())), false),
        Field::new("device", DataType::Int32, true),
        Field::new("value", DataType::Float64, true),
    ])
}

/// A time-series table keyed by device.
pub(crate) fn opts() -> TableOptions {
    TableOptions { time_column: Some("time".into()), series_key: vec!["device".into()], ..Default::default() }
}

/// `(time µs, device, value)` rows.
pub(crate) fn batch(rows: &[(i64, i32, f64)]) -> RecordBatch {
    RecordBatch::try_new(
        Arc::new(schema()),
        vec![
            Arc::new(TimestampMicrosecondArray::from_iter_values(rows.iter().map(|r| r.0)).with_timezone("UTC")),
            Arc::new(Int32Array::from_iter_values(rows.iter().map(|r| r.1))),
            Arc::new(Float64Array::from_iter_values(rows.iter().map(|r| r.2))),
        ],
    )
    .unwrap()
}
