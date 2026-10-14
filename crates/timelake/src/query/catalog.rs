//! The lake as a DataFusion catalog: namespaces are schemas, tables are tables.

use std::collections::BTreeMap;
use std::sync::{Arc, PoisonError, RwLock};

use async_trait::async_trait;
use datafusion::catalog::{CatalogProvider, SchemaProvider, TableProvider};
use datafusion::error::Result as DfResult;

use super::PLAN_CACHE_TTL;
use super::provider::TimelakeProvider;
use crate::error::{Error, Result};
use crate::lake::Lake;
use crate::name::TableName;

pub(super) const INFORMATION_SCHEMA: &str = "information_schema";

/// Namespace → table names, as of the last listing.
type Listing = RwLock<BTreeMap<String, Vec<String>>>;

/// DataFusion asks for schema and table names synchronously (for `information_schema` and `SHOW
/// TABLES`), so listing can't do I/O there: [`Session`](super::Session) lists the lake
/// asynchronously first, and these callbacks answer from that snapshot.
#[derive(Debug)]
pub(super) struct LakeCatalog {
    lake: Lake,
    listing: Arc<Listing>,
}

impl LakeCatalog {
    pub(super) fn new(lake: Lake) -> Self {
        Self { lake, listing: Arc::default() }
    }

    /// Lists namespaces and tables for the synchronous callbacks.
    pub(super) async fn refresh_listing(&self) -> Result<()> {
        let namespaces = self.lake.namespaces().await?;
        let tables = futures::future::try_join_all(namespaces.iter().map(|ns| self.lake.tables(ns))).await?;
        let listing = namespaces
            .into_iter()
            .zip(tables)
            .map(|(ns, names)| (ns, names.iter().map(|n| n.name().to_string()).collect()))
            .collect();
        *self.listing.write().unwrap_or_else(PoisonError::into_inner) = listing;
        Ok(())
    }
}

impl CatalogProvider for LakeCatalog {
    fn schema_names(&self) -> Vec<String> {
        self.listing.read().unwrap_or_else(PoisonError::into_inner).keys().cloned().collect()
    }

    fn schema(&self, name: &str) -> Option<Arc<dyn SchemaProvider>> {
        let listing = self.listing.clone();
        Some(Arc::new(NamespaceSchema { lake: self.lake.clone(), namespace: name.to_string(), listing }))
    }
}

/// One namespace as a DataFusion schema.
#[derive(Debug)]
struct NamespaceSchema {
    lake: Lake,
    namespace: String,
    listing: Arc<Listing>,
}

#[async_trait]
impl SchemaProvider for NamespaceSchema {
    fn table_names(&self) -> Vec<String> {
        let listing = self.listing.read().unwrap_or_else(PoisonError::into_inner);
        listing.get(&self.namespace).cloned().unwrap_or_default()
    }

    async fn table(&self, name: &str) -> DfResult<Option<Arc<dyn TableProvider>>> {
        let Ok(name) = TableName::new(&self.namespace, name) else { return Ok(None) };
        match self.lake.table_recent(&name, PLAN_CACHE_TTL).await {
            Ok(t) => Ok(Some(Arc::new(TimelakeProvider::data(t)))),
            Err(Error::NotFound(_)) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn table_exist(&self, name: &str) -> bool {
        self.table_names().iter().any(|t| t == name)
    }
}
