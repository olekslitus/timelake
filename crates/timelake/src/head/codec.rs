//! The codecs a lake reads and writes heads with: the built-in ones (`arrow`, `json`) and any the
//! application registers with [`Lake::register_head_codec`](crate::Lake::register_head_codec).

use std::collections::HashMap;
use std::sync::{Arc, PoisonError, RwLock};

use timelake_format::head::{ArrowCodec, HeadCodec, JsonCodec};

/// Codecs by name.
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
