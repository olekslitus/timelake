# Timelake

**A serverless time-series lake on Apache Iceberg.** Point it at any object store (S3, R2, GCS, Azure, RustFS/MinIO) or a local directory. Stream or batch-load time-series data. Query it fast. No catalog server, no database, no Glue jobs.

- **Plain Iceberg + Parquet.** DuckDB, Spark, Trino and PyIceberg read Timelake tables directly.
- **Time-series layout built in.** Data is partitioned by time and sorted by `(series key, time)`. Small files from frequent appends are compacted inline, and duplicates are removed (the latest write wins).
- **Fast reads.** The reader prunes files on time and series, and answers "latest value per device" queries from a last-value index instead of a scan.
- **Maintenance included.** Compaction, retention and snapshot expiry run inside the writer, or as one stateless `timelake maintain` command (cron, Lambda, Kubernetes CronJob).

> Status: **v0**, private, under active development. See [SPEC.md](SPEC.md) for the design (§19.0 covers v0's scope), and [bench/results/V0.md](bench/results/V0.md) for v0 against naive Iceberg (the S3 Tables write pattern) and Lance. On S3-compatible storage with 20 ms latency, Timelake is 1.2–16× faster on TSBS IoT and 2.2–9× faster on single-truck queries, depending on table state.

## Quick start

### CLI
```bash
cargo build --release -p timelake-cli         # → target/release/timelake
export TIMELAKE_WAREHOUSE=./warehouse         # or s3://bucket/prefix

# Create a time-series table from a file's schema and load it
timelake import iot.readings readings.parquet --time-column time --series-key device_id
timelake import iot.devices devices.csv       # a plain table (no time column)

timelake sql "SELECT device_id, time_bucket(INTERVAL '1 hour', time) AS h, avg(temp)
              FROM iot.readings WHERE time > now() - INTERVAL '1 day' GROUP BY 1, 2"
timelake latest iot.readings                  # newest row per device, from the index
timelake info iot.readings                    # contract, files, partitions, snapshots
timelake maintain                             # compact + retention + expire, all tables
timelake duckdb iot.readings                  # the SQL to read it from plain DuckDB
```

S3-compatible stores take `-o key=value` options (or the usual `AWS_*` environment variables):
```bash
timelake -w s3://lake/wh -o aws_endpoint=http://localhost:9000 -o aws_allow_http=true ls
```

### Python
```bash
cd crates/timelake-py && maturin develop --release     # or: pip install .
```
```python
import timelake

lake = timelake.Lake("s3://lake/wh", storage_options={"aws_region": "eu-west-1"})
t = lake.create_table("iot.readings", batch.schema,
                      time_column="time", series_key=["device_id"],
                      chunk="day", retention="365d")
t.append(batch)                          # pyarrow Table/RecordBatch/reader, polars, ...
t.append(batch, batch_id="kinesis-shard-7-seq-1234")   # idempotent retries

lake.sql("SELECT * FROM iot.readings WHERE device_id = 'pump-7' ORDER BY time DESC LIMIT 1")
lake.latest("iot.readings")              # pyarrow.Table, one row per device
t.maintain()                             # also runs inline after appends
```

### Plain DuckDB
```sql
INSTALL iceberg; LOAD iceberg;
SELECT * FROM iceberg_scan('s3://lake/wh/iot/readings');   -- reads metadata/version-hint.text
```

## Concepts

| Concept | What it means |
|---|---|
| **Warehouse** | A root location. Tables live at `<warehouse>/<namespace>/<table>/`. |
| **Time-series table** | Has a `time_column` (required, NOT NULL) and optionally a `series_key` (e.g. `device_id`). Partitioned by `chunk` (hour/day/month) and sorted by `(series_key…, time)`. Like a TimescaleDB hypertable. |
| **Plain table** | No time column: device metadata, dimensions. Unpartitioned. |
| **Commit** | Every `append` is one atomic Iceberg snapshot. Commits use put-if-absent on `vN.metadata.json`, so concurrent writers are safe without a catalog service. |
| **Last-value index** | A small Parquet file per snapshot with the newest row per series. Used by `latest()` and by automatic query rewrites. |
| **Maintenance** | Size-tiered compaction inline after appends; full re-sort/dedup, retention and snapshot expiry via `maintain`. |

### Table settings (Iceberg table properties)
| Property | Default | Meaning |
|---|---|---|
| `timelake.time-column` | (none) | Time column |
| `timelake.series-key` | (none) | Comma-separated series key columns |
| `timelake.chunk-interval` | `day` | `hour`, `day` or `month` partitions |
| `timelake.dedup` | on if a series key is set | Drop duplicate `(series, time)` rows during compaction; the latest write wins |
| `timelake.retention` | forever | Drop partitions older than this, e.g. `90d` |
| `timelake.auto-maintain` | `true` | Run compaction and expiry inline after appends |
| `timelake.compact-min-files` | `8` | Inline compaction merges a size tier once it has this many files |
| `timelake.target-file-size-bytes` | 256 MiB | Compaction output size |
| `timelake.row-group-rows` | 1048576 | Parquet row group size (page indexes keep single-series reads selective) |
| `timelake.snapshot-retention` | `1h` | Expire snapshots older than this… |
| `timelake.min-snapshots` / `timelake.max-snapshots` | `5` / `100` | …keeping at least / at most this many |

### Queries the reader accelerates
- **Time and series filters** prune files using Iceberg column bounds, then row groups and pages inside the sorted Parquet files.
- **Latest row per series:** `ROW_NUMBER() OVER (PARTITION BY <series key> ORDER BY <time> DESC) = 1` is rewritten to read the last-value index.
- **Latest row:** `… WHERE <series key filter> ORDER BY <time> DESC LIMIT 1` is also rewritten to read the index.
- `time_bucket(interval, ts [, origin])` (same as DataFusion's `date_bin`).
- **Object storage:** every table a query references is loaded concurrently before planning (version hint, metadata, manifests, last-value index), each Parquet footer is fetched once, and scans use more partitions on remote stores (latency-bound I/O). Table versions loaded for planning are reused for 1 s within a process; the process's own commits are always visible.

## Repository layout
| Path | What |
|---|---|
| `crates/timelake` | Core library: storage (any object store, read-only HTTPS), catalog, writer, commit layer, maintenance, DataFusion reader |
| `crates/timelake-format` | Table conventions shared by the engine and the WASM reader (contract, partitions, Iceberg bounds) |
| `crates/timelake-cli` | `timelake` command |
| `crates/timelake-py` | Python package (PyO3 + maturin) |
| `crates/timelake-wasm` | WebAssembly reader: metadata, pruning, Parquet decoding, latest/range/bucket queries (no I/O) |
| `packages/timelake-client` | `@timelake/client`: TypeScript client around the WASM reader, with Zod-typed rows |
| `dashboard/` | Web app: website, docs, benchmark results, and the Explorer (`/explore`). Deploys to Vercel; see its README |
| `bench/` | Benchmarks: TSBS IoT, TPC-H, ClickBench, the v0 comparison (`bench/v0`), TimescaleDB on Tiger Cloud |
| `scripts/` | Demo warehouse build (`build-demo-warehouse.sh`) and a static server with Range support for testing (`serve-range.mjs`) |
| `spikes/` | Phase 0 experiments |
| `SPEC.md` | Design and decisions |

## Development
```bash
cargo test -p timelake -p timelake-format                # Rust tests
python -m pytest crates/timelake-py/tests                # Python tests (after maturin develop)
(cd packages/timelake-client && bun test)                # TS client + WASM vs the engine (needs scripts/build-demo-warehouse.sh)
(cd packages/timelake-client && bun run build:wasm)      # rebuild the WASM after changing crates/timelake-wasm
```
