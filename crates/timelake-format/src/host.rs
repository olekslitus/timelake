//! What the shared write path needs from where it runs: an object store, a clock, randomness, and
//! a way to wait. The WASM writer implements it over JavaScript (an R2 binding, `fetch`), tests
//! over memory. Paths are absolute URIs, as Iceberg metadata records them.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::future::{Future, ready};
use std::sync::{Arc, Mutex, PoisonError};

use crate::error::{WriteError, WriteResult};

/// An object found by [`Host::list`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Listed {
    /// Absolute URI.
    pub uri: String,
    /// Size in bytes.
    pub size: u64,
}

/// The environment of the shared write path (see the module documentation).
pub trait Host {
    /// A multipart upload in progress.
    type Upload: Upload;

    /// The object at `uri`, or `None` if there is none.
    fn get(&self, uri: &str) -> impl Future<Output = WriteResult<Option<Vec<u8>>>>;
    /// `len` bytes of the object at `uri` from `start`.
    fn get_range(&self, uri: &str, start: u64, len: u64) -> impl Future<Output = WriteResult<Vec<u8>>>;
    /// Whether an object exists at `uri`.
    fn exists(&self, uri: &str) -> impl Future<Output = WriteResult<bool>>;
    /// Writes (or replaces) the object at `uri`.
    fn put(&self, uri: &str, bytes: Vec<u8>) -> impl Future<Output = WriteResult<()>>;
    /// Writes the object at `uri` unless one exists; `false` if one did. The commit primitive.
    fn put_if_absent(&self, uri: &str, bytes: Vec<u8>) -> impl Future<Output = WriteResult<bool>>;
    /// Starts a multipart upload to `uri`.
    fn upload(&self, uri: &str) -> impl Future<Output = WriteResult<Self::Upload>>;
    /// Objects whose URI starts with `prefix`.
    fn list(&self, prefix: &str) -> impl Future<Output = WriteResult<Vec<Listed>>>;
    /// Deletes objects; missing ones are not an error.
    fn delete(&self, uris: &[String]) -> impl Future<Output = WriteResult<()>>;
    /// Milliseconds since the Unix epoch.
    fn now_ms(&self) -> i64;
    /// A random number.
    fn random(&self) -> u64;
    /// Waits `ms` milliseconds.
    fn sleep(&self, ms: u64) -> impl Future<Output = ()>;
}

/// A multipart upload: parts in order, then [`Upload::complete`].
pub trait Upload {
    /// Sends the next part. Every part but the last must be at least the store's minimum (5 MiB on
    /// S3 and R2).
    fn put_part(&mut self, bytes: Vec<u8>) -> impl Future<Output = WriteResult<()>>;
    /// Completes the upload: the object appears.
    fn complete(self) -> impl Future<Output = WriteResult<()>>;
    /// Drops the parts sent.
    fn abort(self) -> impl Future<Output = ()>;
}

/// A [`Host`] in memory, with a fixed clock and a seeded random sequence: for tests.
#[derive(Clone, Debug, Default)]
pub struct MemoryHost {
    objects: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
    clock: Arc<Mutex<i64>>,
    seed: Arc<Mutex<u64>>,
}

impl MemoryHost {
    /// An empty store at time `now_ms`.
    pub fn new(now_ms: i64) -> Self {
        let host = Self::default();
        *host.clock.lock().unwrap_or_else(PoisonError::into_inner) = now_ms;
        host
    }

    /// Moves the clock forward.
    pub fn advance(&self, ms: i64) {
        *self.clock.lock().unwrap_or_else(PoisonError::into_inner) += ms;
    }

    /// The URIs stored, sorted.
    pub fn uris(&self) -> Vec<String> {
        self.objects().keys().cloned().collect()
    }

    fn objects(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Vec<u8>>> {
        self.objects.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// An upload to a [`MemoryHost`].
#[derive(Debug)]
pub struct MemoryUpload {
    host: MemoryHost,
    uri: String,
    bytes: Vec<u8>,
}

impl Upload for MemoryUpload {
    fn put_part(&mut self, bytes: Vec<u8>) -> impl Future<Output = WriteResult<()>> {
        self.bytes.extend(bytes);
        ready(Ok(()))
    }

    fn complete(self) -> impl Future<Output = WriteResult<()>> {
        self.host.objects().insert(self.uri, self.bytes);
        ready(Ok(()))
    }

    fn abort(self) -> impl Future<Output = ()> {
        ready(())
    }
}

impl Host for MemoryHost {
    type Upload = MemoryUpload;

    fn get(&self, uri: &str) -> impl Future<Output = WriteResult<Option<Vec<u8>>>> {
        ready(Ok(self.objects().get(uri).cloned()))
    }

    fn get_range(&self, uri: &str, start: u64, len: u64) -> impl Future<Output = WriteResult<Vec<u8>>> {
        let objects = self.objects();
        ready(objects.get(uri).ok_or_else(|| WriteError::NotFound(uri.to_string())).map(|bytes| {
            let start = usize::try_from(start).unwrap_or(usize::MAX).min(bytes.len());
            let end = start.saturating_add(usize::try_from(len).unwrap_or(usize::MAX)).min(bytes.len());
            bytes[start..end].to_vec()
        }))
    }

    fn exists(&self, uri: &str) -> impl Future<Output = WriteResult<bool>> {
        ready(Ok(self.objects().contains_key(uri)))
    }

    fn put(&self, uri: &str, bytes: Vec<u8>) -> impl Future<Output = WriteResult<()>> {
        self.objects().insert(uri.to_string(), bytes);
        ready(Ok(()))
    }

    fn put_if_absent(&self, uri: &str, bytes: Vec<u8>) -> impl Future<Output = WriteResult<bool>> {
        let mut objects = self.objects();
        let absent = !objects.contains_key(uri);
        if absent {
            objects.insert(uri.to_string(), bytes);
        }
        ready(Ok(absent))
    }

    fn upload(&self, uri: &str) -> impl Future<Output = WriteResult<MemoryUpload>> {
        ready(Ok(MemoryUpload { host: self.clone(), uri: uri.to_string(), bytes: vec![] }))
    }

    fn list(&self, prefix: &str) -> impl Future<Output = WriteResult<Vec<Listed>>> {
        let listed = self
            .objects()
            .range(prefix.to_string()..)
            .take_while(|(k, _)| k.starts_with(prefix))
            .map(|(k, v)| Listed { uri: k.clone(), size: v.len() as u64 })
            .collect();
        ready(Ok(listed))
    }

    fn delete(&self, uris: &[String]) -> impl Future<Output = WriteResult<()>> {
        let mut objects = self.objects();
        for uri in uris {
            objects.remove(uri);
        }
        ready(Ok(()))
    }

    fn now_ms(&self) -> i64 {
        *self.clock.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn random(&self) -> u64 {
        let mut seed = self.seed.lock().unwrap_or_else(PoisonError::into_inner);
        *seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        *seed ^ (*seed >> 29)
    }

    fn sleep(&self, ms: u64) -> impl Future<Output = ()> {
        self.advance(i64::try_from(ms).unwrap_or(i64::MAX));
        ready(())
    }
}

/// A random UUID (version 4) from `host`.
pub fn uuid_v4(host: &impl Host) -> String {
    let mut b = [0u8; 16];
    b[..8].copy_from_slice(&host.random().to_be_bytes());
    b[8..].copy_from_slice(&host.random().to_be_bytes());
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    format_uuid(&b)
}

/// A time-ordered UUID (version 7) from `host`'s clock and randomness, as data files are named.
pub fn uuid_v7(host: &impl Host) -> String {
    let mut b = [0u8; 16];
    let ms = u64::try_from(host.now_ms()).unwrap_or(0);
    b[..6].copy_from_slice(&ms.to_be_bytes()[2..]);
    b[6..14].copy_from_slice(&host.random().to_be_bytes());
    b[14..].copy_from_slice(&host.random().to_be_bytes()[..2]);
    b[6] = (b[6] & 0x0f) | 0x70;
    b[8] = (b[8] & 0x3f) | 0x80;
    format_uuid(&b)
}

fn format_uuid(b: &[u8; 16]) -> String {
    let hex = b.iter().fold(String::with_capacity(32), |mut s, x| {
        let _ = write!(s, "{x:02x}");
        s
    });
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuids_are_well_formed() {
        let host = MemoryHost::new(1_767_225_600_000);
        let v4 = uuid_v4(&host);
        let v7 = uuid_v7(&host);
        for (u, version) in [(&v4, '4'), (&v7, '7')] {
            assert_eq!(u.len(), 36);
            assert_eq!(u.chars().nth(14), Some(version));
            assert!(matches!(u.chars().nth(19), Some('8' | '9' | 'a' | 'b')));
        }
        // Version 7 starts with the time, so later ones sort later.
        host.advance(1);
        assert!(uuid_v7(&host) > v7);
    }
}
