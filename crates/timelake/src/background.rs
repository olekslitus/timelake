//! Writes that finish after the call that started them returns. A commit is done once its
//! metadata is written; updating the version hint after that is only a shortcut for readers, so a
//! commit doesn't wait for it (SPEC §19.1, P4).

use std::future::Future;
use std::sync::{Mutex, PoisonError};

use tokio::task::JoinHandle;

static TASKS: Mutex<Vec<JoinHandle<()>>> = Mutex::new(vec![]);

/// Runs `task` on the current Tokio runtime without waiting for it.
pub(crate) fn spawn(task: impl Future<Output = ()> + Send + 'static) {
    let mut tasks = TASKS.lock().unwrap_or_else(PoisonError::into_inner);
    tasks.retain(|t| !t.is_finished());
    tasks.push(tokio::spawn(task));
}

/// Waits for the background writes this process started. Call it before the process exits, or
/// the last commit's version hint may not be updated: readers still find the newest version, but
/// need an extra request to do so. The CLI and the Python package call it for you.
pub async fn flush() {
    let tasks = std::mem::take(&mut *TASKS.lock().unwrap_or_else(PoisonError::into_inner));
    for task in tasks {
        let _ = task.await;
    }
}
