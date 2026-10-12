//! Python bindings: `timelake.Lake` and `timelake.Table`, Arrow in and out.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use arrow_pyarrow::{FromPyArrow, IntoPyArrow};
use pyo3::exceptions::{PyFileExistsError, PyKeyError, PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::PyDict;
use timelake::arrow::array::{RecordBatch, RecordBatchIterator, RecordBatchReader};
use timelake::arrow::datatypes::Schema;
use arrow_array::ffi_stream::ArrowArrayStreamReader;
use timelake::datafusion::prelude::SessionConfig;
use timelake::{AppendOptions, Chunk, MaintainOptions, Session, TableOptions};

fn rt() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime"))
}

/// Runs a future on the shared runtime with the GIL released.
fn run<F, T>(py: Python<'_>, f: F) -> PyResult<T>
where
    F: std::future::Future<Output = timelake::Result<T>> + Send,
    T: Send,
{
    py.detach(|| rt().block_on(f)).map_err(to_py)
}

fn to_py(e: timelake::Error) -> PyErr {
    match e {
        timelake::Error::NotFound(m) => PyKeyError::new_err(m),
        timelake::Error::AlreadyExists(m) => PyFileExistsError::new_err(m),
        timelake::Error::Invalid(m) | timelake::Error::Config(m) => PyValueError::new_err(m),
        e => PyRuntimeError::new_err(e.to_string()),
    }
}

/// Reads any Arrow-compatible object (pyarrow Table/RecordBatch/RecordBatchReader, polars,
/// anything with `__arrow_c_stream__`) into record batches.
fn batches(data: &Bound<'_, PyAny>) -> PyResult<Vec<RecordBatch>> {
    if let Ok(b) = RecordBatch::from_pyarrow_bound(data) {
        return Ok(vec![b]);
    }
    let reader = ArrowArrayStreamReader::from_pyarrow_bound(data)?;
    reader.collect::<Result<Vec<_>, _>>().map_err(|e: timelake::arrow::error::ArrowError| PyValueError::new_err(e.to_string()))
}

fn to_pyarrow_table(py: Python<'_>, schema: Arc<Schema>, batches: Vec<RecordBatch>) -> PyResult<Py<PyAny>> {
    let reader: Box<dyn RecordBatchReader + Send> = Box::new(RecordBatchIterator::new(batches.into_iter().map(Ok), schema));
    let r = reader.into_pyarrow(py)?;
    Ok(r.call_method0("read_all")?.unbind())
}

/// A warehouse of Timelake tables on any object store or local disk.
///
/// >>> lake = timelake.Lake("s3://bucket/warehouse", storage_options={"aws_region": "us-east-1"})
#[pyclass(frozen, module = "timelake")]
struct Lake {
    inner: timelake::Lake,
    sessions: Mutex<HashMap<String, Session>>,
}

impl Lake {
    fn session(&self, namespace: &str) -> Session {
        let mut s = self.sessions.lock().unwrap();
        s.entry(namespace.to_string())
            .or_insert_with(|| {
                let cfg = SessionConfig::new().with_default_catalog_and_schema("timelake", namespace);
                Session::with_config(self.inner.clone(), cfg)
            })
            .clone()
    }
}

#[pymethods]
impl Lake {
    #[new]
    #[pyo3(signature = (location, storage_options=None))]
    fn new(location: &str, storage_options: Option<HashMap<String, String>>) -> PyResult<Self> {
        let _guard = rt().enter();
        let inner = timelake::Lake::open(location, storage_options.unwrap_or_default()).map_err(to_py)?;
        Ok(Self { inner, sessions: Mutex::default() })
    }

    #[getter]
    fn location(&self) -> String {
        self.inner.location().to_string()
    }

    /// Creates a table from a pyarrow schema (or anything with `.schema`).
    ///
    /// `time_column` makes it a time-series table: partitioned by `chunk` (hour/day/month), sorted
    /// by `(series_key…, time_column)`, with a last-value index and automatic maintenance.
    #[pyo3(signature = (name, schema, time_column=None, series_key=None, chunk=None, retention=None, dedup=None, properties=None))]
    #[allow(clippy::too_many_arguments)]
    fn create_table(
        &self,
        py: Python<'_>,
        name: &str,
        schema: &Bound<'_, PyAny>,
        time_column: Option<String>,
        series_key: Option<Vec<String>>,
        chunk: Option<String>,
        retention: Option<String>,
        dedup: Option<bool>,
        properties: Option<HashMap<String, String>>,
    ) -> PyResult<Table> {
        let schema = match Schema::from_pyarrow_bound(schema) {
            Ok(s) => s,
            Err(_) => Schema::from_pyarrow_bound(&schema.getattr("schema")?)?,
        };
        let opts = TableOptions {
            time_column,
            series_key: series_key.unwrap_or_default(),
            chunk: chunk.as_deref().map(Chunk::parse).transpose().map_err(|e| to_py(e.into()))?,
            dedup,
            retention,
            properties: properties.unwrap_or_default(),
        };
        let lake = self.inner.clone();
        let name = name.to_string();
        let t = run(py, async move { lake.create_table(&name, &schema, opts).await })?;
        Ok(Table { inner: Mutex::new(t) })
    }

    /// Opens an existing table.
    fn table(&self, py: Python<'_>, name: &str) -> PyResult<Table> {
        let lake = self.inner.clone();
        let name = name.to_string();
        let t = run(py, async move { lake.table(&name).await })?;
        Ok(Table { inner: Mutex::new(t) })
    }

    /// Names of all tables as "namespace.table".
    fn tables(&self, py: Python<'_>) -> PyResult<Vec<String>> {
        let lake = self.inner.clone();
        let v = run(py, async move { lake.all_tables().await })?;
        Ok(v.into_iter().map(|t| t.to_string()).collect())
    }

    fn drop_table(&self, py: Python<'_>, name: &str) -> PyResult<()> {
        let lake = self.inner.clone();
        let name = name.to_string();
        run(py, async move { lake.drop_table(&name).await })
    }

    /// Runs SQL and returns a pyarrow Table. Unqualified names resolve in `namespace`.
    #[pyo3(signature = (query, namespace="default"))]
    fn sql(&self, py: Python<'_>, query: &str, namespace: &str) -> PyResult<Py<PyAny>> {
        let session = self.session(namespace);
        let query = query.to_string();
        let (schema, out) = run(py, async move {
            let df = session.sql(&query).await?;
            let schema = Arc::new(df.schema().as_arrow().clone());
            Ok((schema, df.collect().await?))
        })?;
        to_pyarrow_table(py, schema, out)
    }

    /// Newest row of every series of a table, as a pyarrow Table.
    fn latest(&self, py: Python<'_>, table: &str) -> PyResult<Py<PyAny>> {
        let session = self.session("default");
        let table = table.to_string();
        let (schema, out) = run(py, async move {
            let df = session.latest(&table).await?;
            let schema = Arc::new(df.schema().as_arrow().clone());
            Ok((schema, df.collect().await?))
        })?;
        to_pyarrow_table(py, schema, out)
    }

    fn __repr__(&self) -> String {
        format!("Lake({:?})", self.inner.location())
    }
}

/// A Timelake table. Methods that commit (append, maintain) advance this handle to the new
/// version.
#[pyclass(frozen, module = "timelake")]
struct Table {
    inner: Mutex<timelake::Table>,
}

impl Table {
    fn get(&self) -> timelake::Table {
        self.inner.lock().unwrap().clone()
    }
    fn set(&self, t: timelake::Table) {
        *self.inner.lock().unwrap() = t;
    }
}

#[pymethods]
impl Table {
    #[getter]
    fn name(&self) -> String {
        self.get().name.to_string()
    }

    #[getter]
    fn location(&self) -> String {
        self.get().location
    }

    #[getter]
    fn version(&self) -> u64 {
        self.get().version
    }

    /// The table's pyarrow schema.
    #[getter]
    fn schema(&self, py: Python<'_>) -> PyResult<Py<PyAny>> {
        Ok(self.get().schema().as_ref().clone().into_pyarrow(py)?.unbind())
    }

    /// Appends Arrow data (pyarrow Table/RecordBatch/reader, polars DataFrame, …) as one commit.
    /// `batch_id` makes the append idempotent. Returns commit statistics.
    #[pyo3(signature = (data, batch_id=None, maintain=None))]
    fn append<'py>(&self, py: Python<'py>, data: &Bound<'py, PyAny>, batch_id: Option<String>, maintain: Option<bool>) -> PyResult<Bound<'py, PyDict>> {
        let batches = batches(data)?;
        let t = self.get();
        let opts = AppendOptions { batch_id, maintain, ..Default::default() };
        let (t, r) = run(py, async move { t.append(&batches, opts).await })?;
        self.set(t.clone());
        let d = PyDict::new(py);
        d.set_item("rows", r.rows)?;
        d.set_item("files", r.files)?;
        d.set_item("bytes", r.bytes)?;
        d.set_item("version", t.version)?;
        d.set_item("commit_ms", r.commit.duration.as_secs_f64() * 1000.0)?;
        d.set_item("attempts", r.commit.attempts)?;
        d.set_item("duplicate", r.commit.duplicate)?;
        if let Some(m) = r.maintenance {
            d.set_item("maintenance", report(py, &m)?)?;
        }
        Ok(d)
    }

    /// Compaction (sort + dedup), retention, snapshot expiry. Returns what was done.
    #[pyo3(signature = (compact=true, retention=true, expire=true))]
    fn maintain<'py>(&self, py: Python<'py>, compact: bool, retention: bool, expire: bool) -> PyResult<Bound<'py, PyDict>> {
        let t = self.get();
        let opts = MaintainOptions { compact, retention, expire, ..Default::default() };
        let (t, r) = run(py, async move { t.maintain(opts).await })?;
        self.set(t);
        report(py, &r)
    }

    /// Reloads the latest committed version.
    fn refresh(&self, py: Python<'_>) -> PyResult<()> {
        let t = self.get();
        let t = run(py, async move { t.refresh().await })?;
        self.set(t);
        Ok(())
    }

    /// Contract, size and layout of the current version.
    fn info<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyDict>> {
        let t = self.get();
        let t2 = t.clone();
        let (files, manifests) = run(py, async move { Ok((t2.files().await?, t2.manifests().await?.len())) })?;
        let c = &t.contract;
        let d = PyDict::new(py);
        d.set_item("name", t.name.to_string())?;
        d.set_item("version", t.version)?;
        d.set_item("location", &t.location)?;
        d.set_item("time_column", &c.time_column)?;
        d.set_item("series_key", &c.series_key)?;
        d.set_item("chunk", c.chunk.map(|c| c.as_str()))?;
        d.set_item("dedup", c.dedup)?;
        d.set_item("rows", files.iter().map(|f| f.data_file.record_count()).sum::<u64>())?;
        d.set_item("files", files.len())?;
        d.set_item("bytes", files.iter().map(|f| f.data_file.file_size_in_bytes()).sum::<u64>())?;
        d.set_item("snapshots", t.metadata.snapshots().len())?;
        d.set_item("manifests", manifests)?;
        d.set_item("last_value_index", t.last_value_index())?;
        Ok(d)
    }

    fn __repr__(&self) -> String {
        let t = self.get();
        format!("Table({}, v{})", t.name, t.version)
    }
}

fn report<'py>(py: Python<'py>, r: &timelake::MaintainReport) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    d.set_item("partitions_compacted", r.partitions_compacted)?;
    d.set_item("files_rewritten", r.files_rewritten)?;
    d.set_item("files_written", r.files_written)?;
    d.set_item("rows_rewritten", r.rows_rewritten)?;
    d.set_item("duplicates_removed", r.duplicates_removed)?;
    d.set_item("partitions_dropped", r.partitions_dropped)?;
    d.set_item("snapshots_expired", r.snapshots_expired)?;
    d.set_item("objects_deleted", r.objects_deleted)?;
    d.set_item("seconds", r.duration.as_secs_f64())?;
    Ok(d)
}

#[pymodule]
fn _timelake(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<Lake>()?;
    m.add_class::<Table>()?;
    Ok(())
}
