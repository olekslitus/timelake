//! Timelake's session settings, under the `timelake.` prefix of DataFusion's configuration:
//! `SET timelake.read_dedup = false` in SQL, `--set timelake.read_dedup=false` on the CLI. A
//! session setting overrides the table's property for that session (SPEC §21.9).

use datafusion::common::config::ConfigExtension;
use datafusion::common::extensions_options;

extensions_options! {
    /// Timelake settings for one session; unset ones follow each table's properties.
    pub struct SessionSettings {
        /// Remove copies of a `(series…, time)` when reading: overrides the table's
        /// `timelake.read-dedup` (which follows `timelake.dedup`).
        pub read_dedup: Option<bool>, default = None
        /// How copies are removed on read, `merge` or `keys-first`: overrides the table's
        /// `timelake.read-dedup-strategy`.
        pub read_dedup_strategy: Option<String>, default = None
    }
}

impl ConfigExtension for SessionSettings {
    const PREFIX: &'static str = "timelake";
}
