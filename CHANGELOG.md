# Changelog

Changes users can see, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The crates, the Python package and the TypeScript client share one version, which follows
[Semantic Versioning](https://semver.org) (before 1.0, a minor release may break things; the entry says how).

## Unreleased

Nothing has been released yet. This section describes what is on `main`.

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
  `timelake_requests` (`fast` or `cheap`: no LIST, one more round trip), `timelake_freshness_check` (`head` or `list`,
  `list` by default on Tigris) and `timelake_warm_connections` (off by default). The requests each operation makes,
  and what they cost, are in the storage docs. If you write a table with an older Timelake after this one, delete its
  `metadata/timelake-head`.
- **Faster commits:** an append uploads its data files and metadata all at once, then makes the one conditional
  write, so it waits for two round trips to storage instead of five. The version hint is now updated in the
  background; Rust programs should call `timelake::flush()` before exiting (the CLI and the Python package do).
