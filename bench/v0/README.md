# v0 benchmark: Timelake vs. naive Iceberg (S3 Tables pattern) vs. Lance

The question: a team streams IoT data to object storage and queries it. Is Timelake v0 better than what it would otherwise build: PyIceberg/Firehose appends into an S3 Tables-style Iceberg table, or a Lance dataset?

## Workload
- **Data:** TSBS IoT (`readings` and `diagnostics`, 11.7M rows each, 3 days, 500 trucks (4,234 tag ids); `tags` dimension), the same data as the Phase 0 baseline.
- **Ingest:** streamed in **5-minute windows** (Firehose's default buffer interval): 864 windows × 2 tables = **1,728 commits**, about 13.5k rows each. Every system gets identical rows.
- **Queries:** the 12 TSBS IoT queries plus 5 single-truck queries (`queries/tsbs_iot`, `queries/iot_point`). Each query runs in a fresh process: one first run (cold: metadata, footers, data) plus repeats.
- **Storage:** local disk, and RustFS behind `tools/s3proxy` with 20 ms time-to-first-byte per request (roughly S3 standard in-region). Ingest and queries both go through the proxy. The same benchmark also runs against real AWS S3 and S3 Tables (`../run_aws.sh`, results in [S3.md](../results/S3.md)).
- **States:** right after ingest ("ingested"), and after each system's standard maintenance ("maintained").

## Systems
| System | Write path | Maintenance | Read paths |
|---|---|---|---|
| **Iceberg** (the S3 Tables write pattern) | PyIceberg `append` per window into a `day(time)`-partitioned table | Binpack compaction (S3 Tables' default), simulated by rewriting each table with PyIceberg `overwrite`; snapshots kept | DuckDB `iceberg_scan` |
| **Lance** | `lance.write_dataset(mode="append")` per window | `compact_files()` + `cleanup_old_versions()` | DuckDB (pyarrow dataset interface); DataFusion + Lance's scanner (`FFILanceTableProvider`) |
| **Timelake v0** | `Table.append` per window, with inline size-tiered compaction and snapshot expiry | `Table.maintain()`: one sorted file per partition, expiry, cleanup | Timelake reader (CLI, DataFusion inside); plain DuckDB `iceberg_scan` on the same tables |

On RustFS, S3 Tables can't run, so its managed compaction is simulated: it runs asynchronously (minutes to hours later) and is billed per object and GB processed, and "ingested" is the state its readers see until it has run. The Iceberg write and read pattern is identical. The AWS runs use real S3 Tables (`--system s3tables`), including waiting for its own compaction.

## Run
```bash
# from bench/; for --storage s3, RustFS + proxy as in bench/README.md
for s in iceberg lance timelake; do uv run python v0/ingest.py --system $s --storage local; done
v0/run_queries.sh local ingested
for s in iceberg lance timelake; do uv run python v0/ingest.py --system $s --storage local --maintain-only; done
v0/run_queries.sh local maintained
# same with --storage s3 / "s3"
uv run python v0/summarize.py > results/V0.md
```

`v0/small.py` is a quick version for any S3-compatible store with no proxy (100 commits and four queries, small
enough for free tiers): see its docstring. Results of the performance plan's steps are in
[PERFORMANCE.md](../results/PERFORMANCE.md).

## TimescaleDB (Tiger Cloud)
`v0/tsdb_cloud.py` loads the same tables into a Tiger Cloud service and runs the same queries in up to three states: plain hypertable, columnstore, and tiered storage. Use a disposable service and set `TSDB_DSN`. Results go to `results/tsdb_cloud.jsonl`; the write-up is [results/TIMESCALE.md](../results/TIMESCALE.md). Tiered storage must be enabled in the Tiger Console first.
