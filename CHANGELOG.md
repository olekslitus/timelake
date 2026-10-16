# Changelog

Changes users can see, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The crates, the CLI, the Python package, the WASM reader and the TypeScript client share one version, which follows
[Semantic Versioning](https://semver.org) as [Cargo applies it](https://doc.rust-lang.org/cargo/reference/semver.html):
before 1.0, a minor release (0.3 → 0.4) may break things, and its entry says how; a patch release never does. Each
version is a [tag on GitHub](https://github.com/polythings/timelake/tags), so its code and benchmarks can be checked out.

## Unreleased

### Added

- **Dedup on read.** In tables with dedup on, the Timelake reader (CLI, Python, Rust) returns only the latest write of
  each `(series, time)`, before compaction has removed the older copies. Only files that may share a key are merged;
  the rest are read as before. DuckDB, other Iceberg readers and the TypeScript client still see the copies until
  compaction. It can be turned off per table (`timelake.read-dedup = false`) or per session
  (`SET timelake.read_dedup = false`, or `--set timelake.read_dedup=false` on the CLI). A second strategy,
  `timelake.read-dedup-strategy = keys-first`, lists the older copies first and leaves them out of a normal scan.
- **Cold partitions compact sooner.** Once newer data is `timelake.compact-cold-after` (default 1 hour) past a
  partition's end, inline maintenance rewrites the partition into sorted, duplicate-free files when it has two small
  files, even if the append didn't touch it.

- **Insertion time.** Time-series tables get an `_ingest_ts` column: each append fills it with the time the append
  started, unless the input brings its own values (an import keeping arrival times). Among rows with the same
  `(series, time)` the latest insertion wins, then the later commit, everywhere: within an append, on read, in
  compaction and in the last-value index. DuckDB can pick the same rows with
  `QUALIFY row_number() OVER (PARTITION BY <series>, <time> ORDER BY _ingest_ts DESC) = 1`. Leave it out with
  `ingest_time=False` (Python) or `--no-ingest-time` (CLI); `timelake info` shows it.
- **Settings.** Every switch is declared in one registry, with its default, the levels it can be set at (creation,
  table, session, call) and the version that added it. `timelake settings` lists them, and with a table name shows
  the table's values; `timelake alter <table> --set read-dedup=false --unset retention` changes a table's settings
  (`Table.set_properties` in Python and Rust). `Lake(..., settings={...})` in Python sets session settings for every
  query, and `SHOW timelake.read_dedup` shows a session's value. Names work with dashes or underscores, with or
  without `timelake.`. The docs page "Table properties" is now "Settings".

### Changed

- **Settings are checked.** Creating or altering a table with an unknown `timelake.*` property, a bad value, or a
  setting fixed at creation (`time-column`, `series-key`, `chunk-interval`, `dedup`, `ingest-time-column`) as a
  property is an error; use the table options for those. `timelake.format-version` can no longer be set by hand.
  `SET` of a table-only setting in SQL is an error. `timelake sql --set` with a bad key reports an error instead of
  crashing.
- Rust: `SessionSettings` has `get` and `flag` instead of public fields.

- **Table format 0.3.0** for new tables (the insertion-time column). Timelake 0.4 and older can't open them: upgrade
  every reader and writer first. `timelake upgrade` raises older tables to 0.3.0 but doesn't add `_ingest_ts` (a
  table's columns are fixed at creation for now).
- With dedup on, rows with the same `(series, time)` within one append keep only the last, so the append's `rows`
  counts them once. Files written by earlier versions may still hold such copies until compaction.
- The TypeScript client's WebAssembly reader is about 4% smaller (6.7 MB), built with Rust 1.99.

### Fixed

- **Compaction could let an older write win.** Inline compaction merged files of a similar size even when a file of
  another size was committed between them, and the merged file then counted as newer than that file: where both held
  the same `(series, time)`, the older value won from then on. Compaction now merges only files next to each other in
  commit order, and a merged file keeps the data sequence number of the newest file it replaces.

## 0.4.0 – 2026-10-14

### Added

- **Install from the usual registries:** `pip install timelake`, `cargo install timelake-cli` (or the `timelake`
  library crate), and `npm install @timelake/client`. The CLI also has one-line installers for macOS, Linux and
  Windows and binaries on each [GitHub release](https://github.com/polythings/timelake/releases), with build
  attestations. See the [Quick start](https://timelake.dev/docs/quick-start).

### Changed

- **Table format versions are semantic versions,** separate from Timelake's: tables created now record
  `timelake.format-version = 0.2.0`. Tables marked `2` by Timelake 0.3.0 read as 0.2.0 and need no upgrade; tables
  without the property are 0.1.0. A newer patch format is read and written by older Timelakes, a newer minor format
  (before 1.0) by neither, with a message to upgrade Timelake. See
  [Upgrading](https://timelake.dev/docs/upgrading#table-format). Timelake 0.3.0 can't open tables created from now on:
  upgrade every reader and writer first.

## 0.3.0 – 2026-10-14

### Added

- **Table format version:** tables record `timelake.format-version` (2 for tables created now; tables without it are
  format 1). Timelake reads tables of any older format and refuses to write to a table of a newer format than it
  knows, with a message to upgrade.
- **`timelake upgrade`** (also `Table.upgrade()` in Python and Rust) brings tables to the current format: records the
  format version, builds a missing last-value index, rewrites unsorted or small files and writes the head. Each step is
  a commit, and no snapshot expires for 7 days (`--keep-snapshots`), so **`timelake rollback <table> <snapshot>`**
  (`Table.rollback()`) undoes it. `--dry-run` shows the plan. New table property `timelake.keep-snapshots-until`.

### Fixed

- After a rollback, a batch id from the abandoned snapshots no longer counts as already committed.

### Changed

- **Faster first queries:** after each commit the writer also writes `metadata/timelake-head`, which holds the table
  metadata, the live files, and (while they fit in 1 MiB) the last-value index and the Parquet footers of the newest
  files. A cold query reads it together with a listing of the table's metadata files that confirms it is current, so a
  first `latest` query takes one round trip to storage instead of three, and a first filtered scan two instead of six.
  A process that already has a table only checks for a newer version. Measured from a laptop, first queries take
  245–545 ms instead of 510–1,030 on S3, and 210–520 instead of 760–1,190 on Tigris. The TypeScript client reads the
  head too and checks for a newer version while its query runs (`TableInfo.manifests` is `null` for a table read from
  its head). Other engines see no change. New table properties `timelake.head-format` (`arrow`, `json`, a codec
  registered with `Lake::register_head_codec`, or `none`) and `timelake.head-inline-bytes`; new storage options
  `timelake_version_lookup` (`list` or `hint`: no LIST, one more round trip), `timelake_freshness_check` (`head` or `list`,
  `list` by default on Tigris) and `timelake_warm_connections` (off by default). The requests each operation makes,
  and what they cost, are in the storage docs. If you write a table with an older Timelake after this one, delete its
  `metadata/timelake-head`.

## 0.2.0 – 2026-10-14

Tagged after the fact: the code at this tag still reports version 0.0.1.

### Changed

- **Faster commits:** an append uploads its data files and metadata all at once, then makes the one conditional
  write, so it waits for two round trips to storage instead of five. The version hint is now updated in the
  background; Rust programs should call `timelake::flush()` before exiting (the CLI and the Python package do).

## 0.1.0 – 2026-10-13

The first version. Tagged after the fact: the code at this tag reports version 0.0.1.

### Added

- **Engine** (`timelake` crate): time-series and plain tables stored as Parquet files with Apache Iceberg metadata, on
  S3, GCS, Azure, S3-compatible stores (R2, MinIO, RustFS) or a local disk. Read-only access over HTTPS.
  - Time-series tables are partitioned by `hour`, `day` or `month` and sorted by `(series key, time)`.
  - Every append is one atomic commit. Concurrent writers are safe without a catalog service (put-if-absent on
    `vN.metadata.json`); a conflicting commit is rebased and retried.
  - Idempotent appends with a `batch_id`: a repeated batch is skipped and reported as 0 rows.
  - A last-value index per snapshot gives the newest row of every series without a scan.
  - Maintenance (compaction, deduplication where the latest write wins, retention, snapshot expiry) runs inline after
    appends, or on demand. A maintenance failure is reported separately and never undoes the append.
  - SQL through DataFusion, with `time_bucket()`, file, row group and page pruning, and "latest row" queries rewritten
    to read the index.
- **CLI** (`timelake`): `create`, `append`, `import`, `sql`, `latest`, `maintain`, `info`, `ls`, `duckdb`, `drop` and
  `index`. Loads Parquet, CSV, gzipped CSV and TSV.
- **Python** (`timelake` package): `Lake` and `Table` with `create_table`, `append` (pyarrow, polars or any Arrow
  stream), `sql`, `latest` and `maintain`, returning pyarrow tables. Full type stubs. Invalid input raises
  `ValueError`, a missing table `KeyError`, and an unresolvable concurrent commit `timelake.ConflictError`.
- **WebAssembly reader and TypeScript client** (`@timelake/client`): reads tables over HTTPS in the browser or Node,
  with latest, range and time-bucket queries and Zod-typed rows.
- **Open format:** plain DuckDB, Spark and PyIceberg read every table. `timelake duckdb <table>` prints the SQL.
