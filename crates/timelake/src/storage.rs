//! Object storage access. One `object_store` client serves everything: Iceberg metadata (through an
//! adapter that implements iceberg-rust's `Storage` trait), Parquet data written by Timelake, and
//! DataFusion scans. Any `object_store` backend works: S3 and S3-compatible stores (R2, RustFS,
//! MinIO), GCS, Azure, and local disk.

use std::collections::HashMap;
use std::ops::Range;
use std::str::FromStr;
use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use futures::StreamExt;
use futures::stream::BoxStream;
use iceberg::io::{
    FileIO, FileIOBuilder, FileMetadata, FileRead, FileWrite, InputFile, OutputFile, StorageConfig, StorageFactory,
};
use object_store::aws::{AmazonS3Builder, AmazonS3ConfigKey, S3ConditionalPut};
use object_store::azure::{AzureConfigKey, MicrosoftAzureBuilder};
use object_store::buffered::BufWriter;
use object_store::gcp::{GoogleCloudStorageBuilder, GoogleConfigKey};
use object_store::http::HttpBuilder;
use object_store::local::LocalFileSystem;
use object_store::memory::InMemory;
use object_store::path::Path;
use object_store::{ObjectStore, ObjectStoreExt, PutMode, PutOptions, PutPayload};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use url::Url;

use crate::error::{Error, Result};

/// A store rooted at one URL authority (`s3://bucket`, `file://`, ...). Paths handed to Timelake and
/// written into Iceberg metadata are absolute URIs; [`Storage::path`] maps them to store paths.
#[derive(Clone, Debug)]
pub struct Storage {
    store: Arc<dyn ObjectStore>,
    /// `scheme://authority` with no trailing slash, e.g. `s3://bucket` or `file://`.
    base: String,
    listable: bool,
}

/// Storage option mapping a warehouse URL onto a local directory (see [`Storage::open`]).
pub const LOCAL_ROOT_OPTION: &str = "timelake_local_root";

impl Storage {
    /// Opens the store for `url`. `options` are backend config keys (e.g. `aws_endpoint`,
    /// `aws_access_key_id`, `google_service_account`); for S3, GCS and Azure the usual environment
    /// variables are read as well.
    ///
    /// `timelake_local_root=<dir>` maps the URL onto a local directory: objects are written under
    /// `<dir>` while every path recorded in metadata keeps the URL. That builds a warehouse on disk
    /// that is ready to upload to its final location, e.g. a public Vercel Blob or CDN URL that is
    /// then read over HTTPS.
    pub fn open(url: &Url, options: &HashMap<String, String>) -> Result<Self> {
        let mut options = options.clone();
        let local_root = options.remove(LOCAL_ROOT_OPTION);
        let scheme = url.scheme();
        let authority = url.host_str().unwrap_or_default();
        let base = match scheme {
            // Keep the port for HTTP origins (e.g. http://127.0.0.1:4000).
            "http" | "https" => url.origin().ascii_serialization(),
            _ => format!("{scheme}://{authority}"),
        };
        if let Some(dir) = local_root {
            std::fs::create_dir_all(&dir)?;
            let store = LocalFileSystem::new_with_prefix(&dir)?;
            return Ok(Self { store: Arc::new(store), base, listable: true });
        }
        let store: Arc<dyn ObjectStore> = match scheme {
            "file" => Arc::new(LocalFileSystem::new()),
            // Plain HTTPS (public buckets, Vercel Blob, CDNs): read-only, and it cannot list,
            // so table discovery uses the warehouse's `timelake-tables.json` index.
            "http" | "https" => {
                let mut b = HttpBuilder::new().with_url(&base);
                if scheme == "http" {
                    b = b.with_client_options(object_store::ClientOptions::new().with_allow_http(true));
                }
                Arc::new(b.build()?)
            }
            "memory" => Arc::new(InMemory::new()),
            "s3" | "s3a" => {
                let mut b = AmazonS3Builder::from_env()
                    .with_bucket_name(authority)
                    // Atomic commits rely on put-if-absent (`If-None-Match: *`), supported by AWS S3
                    // since 2024 and by most S3-compatible stores.
                    .with_conditional_put(S3ConditionalPut::ETagMatch);
                for (k, v) in &options {
                    let key = AmazonS3ConfigKey::from_str(k)
                        .map_err(|_| Error::config(format!("unknown S3 option {k:?}")))?;
                    b = b.with_config(key, v);
                }
                Arc::new(b.build()?)
            }
            "gs" => {
                let mut b = GoogleCloudStorageBuilder::from_env().with_bucket_name(authority);
                for (k, v) in &options {
                    let key =
                        GoogleConfigKey::from_str(k).map_err(|_| Error::config(format!("unknown GCS option {k:?}")))?;
                    b = b.with_config(key, v);
                }
                Arc::new(b.build()?)
            }
            "az" | "abfs" | "abfss" => {
                let mut b = MicrosoftAzureBuilder::from_env().with_url(url.as_str());
                for (k, v) in &options {
                    let key = AzureConfigKey::from_str(k)
                        .map_err(|_| Error::config(format!("unknown Azure option {k:?}")))?;
                    b = b.with_config(key, v);
                }
                Arc::new(b.build()?)
            }
            other => return Err(Error::config(format!("unsupported storage scheme {other:?}"))),
        };
        let listable = !matches!(scheme, "http" | "https");
        Ok(Self { store, base, listable })
    }

    /// Whether the store supports listing (plain HTTPS does not).
    pub fn can_list(&self) -> bool {
        self.listable
    }

    pub fn object_store(&self) -> Arc<dyn ObjectStore> {
        self.store.clone()
    }

    /// `scheme://authority`, the key DataFusion registers this store under.
    pub fn base_url(&self) -> &str {
        &self.base
    }

    /// Store path for an absolute URI under this store.
    pub fn path(&self, uri: &str) -> Result<Path> {
        let rest =
            uri.strip_prefix(&self.base).ok_or_else(|| Error::config(format!("{uri} is not under {}", self.base)))?;
        Ok(Path::parse(rest.trim_start_matches('/'))?)
    }

    pub async fn read(&self, uri: &str) -> Result<Bytes> {
        Ok(self.store.get(&self.path(uri)?).await?.bytes().await?)
    }

    /// Like [`Self::read`], but `Ok(None)` when the object doesn't exist.
    pub async fn read_opt(&self, uri: &str) -> Result<Option<Bytes>> {
        match self.store.get(&self.path(uri)?).await {
            Ok(r) => Ok(Some(r.bytes().await?)),
            Err(object_store::Error::NotFound { .. }) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub async fn exists(&self, uri: &str) -> Result<bool> {
        match self.store.head(&self.path(uri)?).await {
            Ok(_) => Ok(true),
            Err(object_store::Error::NotFound { .. }) => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    pub async fn write(&self, uri: &str, bytes: Bytes) -> Result<()> {
        self.store.put(&self.path(uri)?, PutPayload::from_bytes(bytes)).await?;
        Ok(())
    }

    /// Writes only if the object doesn't exist yet. Returns `false` if it already existed.
    /// This is the commit primitive of the object-store catalog.
    pub async fn write_if_absent(&self, uri: &str, bytes: Bytes) -> Result<bool> {
        let opts = PutOptions { mode: PutMode::Create, ..Default::default() };
        match self.store.put_opts(&self.path(uri)?, PutPayload::from_bytes(bytes), opts).await {
            Ok(_) => Ok(true),
            Err(object_store::Error::AlreadyExists { .. }) | Err(object_store::Error::Precondition { .. }) => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    pub async fn delete(&self, uri: &str) -> Result<()> {
        match self.store.delete(&self.path(uri)?).await {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// Deletes many objects, using batch deletes where the backend supports them.
    pub async fn delete_many(&self, uris: Vec<String>) -> Result<usize> {
        let paths = uris.iter().map(|u| self.path(u)).collect::<Result<Vec<_>>>()?;
        let n = paths.len();
        let stream = futures::stream::iter(paths.into_iter().map(Ok)).boxed();
        let mut results = self.store.delete_stream(stream);
        while let Some(r) = results.next().await {
            match r {
                Ok(_) | Err(object_store::Error::NotFound { .. }) => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(n)
    }

    /// Immediate child "directories" of `uri` (a prefix ending without `/`).
    pub async fn list_dirs(&self, uri: &str) -> Result<Vec<String>> {
        let prefix = self.path(uri)?;
        let res = self.store.list_with_delimiter(Some(&prefix)).await?;
        Ok(res.common_prefixes.iter().filter_map(|p| p.filename().map(str::to_string)).collect())
    }

    /// All objects under `uri`, as absolute URIs with size and last-modified time.
    pub async fn list(&self, uri: &str) -> Result<Vec<(String, u64, chrono::DateTime<chrono::Utc>)>> {
        let prefix = self.path(uri)?;
        let mut out = vec![];
        let mut s = self.store.list(Some(&prefix));
        while let Some(m) = s.next().await {
            let m = m?;
            out.push((format!("{}/{}", self.base, m.location), m.size, m.last_modified));
        }
        Ok(out)
    }

    /// An iceberg-rust `FileIO` backed by this store.
    pub fn file_io(&self) -> FileIO {
        FileIOBuilder::new(Arc::new(IcebergStorageFactory { inner: Some(self.clone()) })).build()
    }

    pub fn iceberg_storage(&self) -> Arc<dyn iceberg::io::Storage> {
        Arc::new(IcebergStorage { inner: Some(self.clone()) })
    }

    pub fn output_file(&self, uri: &str) -> OutputFile {
        OutputFile::new(self.iceberg_storage(), uri.to_string())
    }
}

// --- iceberg-rust adapter -----------------------------------------------------------------------
//
// iceberg-rust storage is pluggable (`Storage` + `StorageFactory`). Both traits require serde via
// typetag so storages can cross process boundaries; Timelake never serializes them, so the store
// handle is skipped and a deserialized instance is unusable by design.

fn ice_err(e: impl std::fmt::Display) -> iceberg::Error {
    iceberg::Error::new(iceberg::ErrorKind::Unexpected, e.to_string())
}

#[derive(Debug, Serialize, Deserialize)]
struct IcebergStorageFactory {
    #[serde(skip)]
    inner: Option<Storage>,
}

#[typetag::serde]
impl StorageFactory for IcebergStorageFactory {
    fn build(&self, _config: &StorageConfig) -> iceberg::Result<Arc<dyn iceberg::io::Storage>> {
        let inner = self.inner.clone().ok_or_else(|| ice_err("detached Timelake storage"))?;
        Ok(Arc::new(IcebergStorage { inner: Some(inner) }))
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct IcebergStorage {
    #[serde(skip)]
    inner: Option<Storage>,
}

impl IcebergStorage {
    fn s(&self) -> iceberg::Result<&Storage> {
        self.inner.as_ref().ok_or_else(|| ice_err("detached Timelake storage"))
    }
    fn p(&self, path: &str) -> iceberg::Result<Path> {
        self.s()?.path(path).map_err(ice_err)
    }
}

#[async_trait]
#[typetag::serde]
impl iceberg::io::Storage for IcebergStorage {
    async fn exists(&self, path: &str) -> iceberg::Result<bool> {
        self.s()?.exists(path).await.map_err(ice_err)
    }

    async fn metadata(&self, path: &str) -> iceberg::Result<FileMetadata> {
        let m = self.s()?.store.head(&self.p(path)?).await.map_err(ice_err)?;
        Ok(FileMetadata { size: m.size })
    }

    async fn read(&self, path: &str) -> iceberg::Result<Bytes> {
        self.s()?.read(path).await.map_err(ice_err)
    }

    async fn reader(&self, path: &str) -> iceberg::Result<Box<dyn FileRead>> {
        Ok(Box::new(ObjectRead { store: self.s()?.store.clone(), path: self.p(path)? }))
    }

    async fn write(&self, path: &str, bs: Bytes) -> iceberg::Result<()> {
        self.s()?.write(path, bs).await.map_err(ice_err)
    }

    async fn writer(&self, path: &str) -> iceberg::Result<Box<dyn FileWrite>> {
        Ok(Box::new(ObjectWrite { inner: Some(BufWriter::new(self.s()?.store.clone(), self.p(path)?)) }))
    }

    async fn delete(&self, path: &str) -> iceberg::Result<()> {
        self.s()?.delete(path).await.map_err(ice_err)
    }

    async fn delete_prefix(&self, path: &str) -> iceberg::Result<()> {
        let s = self.s()?;
        let uris = s.list(path).await.map_err(ice_err)?.into_iter().map(|(u, _, _)| u).collect();
        s.delete_many(uris).await.map_err(ice_err)?;
        Ok(())
    }

    async fn delete_stream(&self, mut paths: BoxStream<'static, String>) -> iceberg::Result<()> {
        let mut all = vec![];
        while let Some(p) = paths.next().await {
            all.push(p);
        }
        self.s()?.delete_many(all).await.map_err(ice_err)?;
        Ok(())
    }

    fn new_input(&self, path: &str) -> iceberg::Result<InputFile> {
        Ok(InputFile::new(Arc::new(IcebergStorage { inner: self.inner.clone() }), path.to_string()))
    }

    fn new_output(&self, path: &str) -> iceberg::Result<OutputFile> {
        Ok(OutputFile::new(Arc::new(IcebergStorage { inner: self.inner.clone() }), path.to_string()))
    }
}

struct ObjectRead {
    store: Arc<dyn ObjectStore>,
    path: Path,
}

#[async_trait]
impl FileRead for ObjectRead {
    async fn read(&self, range: Range<u64>) -> iceberg::Result<Bytes> {
        self.store.get_range(&self.path, range).await.map_err(ice_err)
    }
}

struct ObjectWrite {
    inner: Option<BufWriter>,
}

#[async_trait]
impl FileWrite for ObjectWrite {
    async fn write(&mut self, bs: Bytes) -> iceberg::Result<()> {
        let w = self.inner.as_mut().ok_or_else(|| ice_err("write after close"))?;
        w.put(bs).await.map_err(ice_err)
    }

    async fn close(&mut self) -> iceberg::Result<()> {
        let mut w = self.inner.take().ok_or_else(|| ice_err("file already closed"))?;
        w.shutdown().await.map_err(ice_err)
    }
}

/// Normalizes a warehouse location: absolute and relative local paths become `file://` URLs.
pub fn warehouse_url(location: &str) -> Result<Url> {
    if location.contains("://") {
        let s = location.trim_end_matches('/');
        return Url::parse(s).map_err(|e| Error::config(format!("bad warehouse URL {location}: {e}")));
    }
    let p = std::path::Path::new(location);
    std::fs::create_dir_all(p)?;
    let abs = p.canonicalize()?;
    Url::from_directory_path(&abs)
        .map(|u| Url::parse(u.as_str().trim_end_matches('/')).unwrap())
        .map_err(|_| Error::config(format!("bad local path {location}")))
}
