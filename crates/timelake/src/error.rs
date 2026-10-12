use thiserror::Error as ThisError;

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug, ThisError)]
pub enum Error {
    #[error("{0}")]
    Config(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("already exists: {0}")]
    AlreadyExists(String),
    #[error("invalid: {0}")]
    Invalid(String),
    /// Another writer committed first and the operation could not be rebased.
    #[error("commit conflict: {0}")]
    Conflict(String),
    #[error(transparent)]
    Iceberg(#[from] iceberg::Error),
    #[error(transparent)]
    ObjectStore(#[from] object_store::Error),
    #[error(transparent)]
    ObjectPath(#[from] object_store::path::Error),
    #[error(transparent)]
    Arrow(#[from] arrow::error::ArrowError),
    #[error(transparent)]
    Parquet(#[from] parquet::errors::ParquetError),
    #[error(transparent)]
    DataFusion(#[from] datafusion::error::DataFusionError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl Error {
    pub fn config(msg: impl Into<String>) -> Self {
        Self::Config(msg.into())
    }
    pub fn invalid(msg: impl Into<String>) -> Self {
        Self::Invalid(msg.into())
    }
}

impl From<Error> for datafusion::error::DataFusionError {
    fn from(e: Error) -> Self {
        match e {
            Error::DataFusion(e) => e,
            e => datafusion::error::DataFusionError::External(Box::new(e)),
        }
    }
}
