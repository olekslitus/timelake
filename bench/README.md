# timelake-bench

Benchmarks for SPEC.md §17: Timelake against the engines and table formats it builds on and competes with.

| Benchmark | Question | Run | Report |
|---|---|---|---|
| **Query suites** | How fast are DuckDB, DataFusion, Polars, Iceberg and Vortex on our data layouts, on local disk and on S3? | `run.py` (one suite × one engine), `run_aws.sh` | [`results/BASELINE.md`](results/BASELINE.md), [`OBJECT_STORAGE.md`](results/OBJECT_STORAGE.md), [`VORTEX.md`](results/VORTEX.md), [`S3.md`](results/S3.md) |
| **v0 comparison** | The same IoT stream written into Timelake, naive Iceberg, S3 Tables and Lance: ingest, then queries before and after each system's maintenance | [`v0/README.md`](v0/README.md) | [`results/V0.md`](results/V0.md), [`S3.md`](results/S3.md) |
| **TimescaleDB** | The same tables and queries on Tiger Cloud | `v0/tsdb_cloud.py` | [`results/TIMESCALE.md`](results/TIMESCALE.md) |

## Setup
```bash
uv sync                                                    # at the repo root: Python 3.13, the engines, and timelake (built from crates/timelake-py)
(cd tools/s3proxy && go build -o ../../.bin/s3proxy .)     # request-counting S3 proxy
(cd rust-reader && cargo build --release)                  # DataFusion 55 + Vortex reader (engines datafusion-rs*)
GOBIN=$PWD/.bin go install github.com/timescale/tsbs/cmd/tsbs_generate_data@latest
```
Run Python from anywhere in the repo with `uv run python …`; it uses the root `.venv`.

## Data
Generated locally into `bench/data/` (git-ignored, several GB). Same generators and seeds everywhere:
```bash
.bin/tsbs_generate_data --use-case=iot --seed=123 --scale=500 \
  --timestamp-start=2026-01-01T00:00:00Z --timestamp-end=2026-01-04T00:00:00Z \
  --log-interval=10s --format=timescaledb | uv run python scripts/tsbs_to_parquet.py data/tsbs/parquet
uv run python scripts/to_vortex.py          # Vortex copies
uv run python scripts/tsbs_to_iceberg.py    # Iceberg copy (PyIceberg); add "s3" to write it through the proxy
```
TPC-H SF10 and the ClickBench 10% subset are generated as in `infra/remote.sh` (`data`).

| Suite | Data | Queries |
|---|---|---|
| `tsbs_iot` | TSBS IoT, 500 trucks × 3 days at 10 s (11.7M readings + 11.7M diagnostics, ~10% missing points by design), seed 123 | 12 TSBS IoT queries ported to portable SQL (`queries/tsbs_iot/queries.sql`, porting rules in its header) |
| `iot_point` | the same data | 5 single-truck queries (`queries/iot_point`) |
| `tpch` | TPC-H SF10 as Parquet (zstd), from DuckDB `dbgen` | 22 TPC-H queries from DuckDB's `tpch` extension |
| `clickbench` | ClickBench `hits`, 10% subset (partitions 0–9 of 100, ~10M rows) | 43 official queries, each engine's own SQL |

## Engines
- `duckdb`, `datafusion`, `polars`: the Python packages over Parquet (versions recorded in every result).
- `duckdb-iceberg`: DuckDB over the TSBS data as Iceberg tables (PyIceberg, `day(time)` partitions, sorted by `(tags_id, time)`).
- `duckdb-vortex`, `datafusion-rs`, `datafusion-rs-vortex`: Vortex files, and DataFusion 55 in Rust (`rust-reader/`).
- `v0-*`: the systems of the v0 comparison (see `v0/README.md`).

## Method
- Each query runs in a fresh process: one first run, then repeats. Every run fully materializes the result as Arrow, and row counts are compared across engines.
- "First run" is not cold-cache on local disk: the OS page cache stays warm (dropping it needs root on macOS).
- Engines run one at a time, with default settings and all cores.
- With `--storage s3`, all reads go through `tools/s3proxy`, which counts requests and bytes per run. It can add a fixed time-to-first-byte (`-ttfb`, for a local RustFS) or, in AWS mode (`-aws-bucket`), sign requests for a real bucket.

## Runs
**Local disk:**
```bash
uv run python run.py --suite tsbs_iot --engine duckdb --layout sorted --tag mytag
```

**S3-compatible storage on this machine (RustFS + 20 ms per request):**
```bash
docker volume create timelake-bench-rustfs
docker run -d --name timelake-bench-rustfs -p 59000:9000 -v timelake-bench-rustfs:/data \
  -e RUSTFS_ACCESS_KEY=benchkey -e RUSTFS_SECRET_KEY=benchsecret123 rustfs/rustfs:latest
.bin/s3proxy -listen :59100 -upstream localhost:59000 -admin :59101 -ttfb 20ms &
# upload data/{tpch,clickbench,tsbs/parquet*} to s3://bench/…, then:
uv run python run.py --suite tsbs_iot --engine duckdb --storage s3 --tag rustfs-20ms
docker rm -f timelake-bench-rustfs && docker volume rm timelake-bench-rustfs     # cleanup
```

**Real AWS S3** (from this machine, or from an instance in the region): see [`infra/README.md`](infra/README.md).

## Results
`results/<suite>.<tag>.jsonl` holds one record per query and engine; the `.md` files are the write-ups. The website reads a copy of some of them (`dashboard/data/results`, refreshed with `bun run sync-results`).

The Phase 0 runners that produced `BASELINE.md`, `OBJECT_STORAGE.md` and `VORTEX.md` (`run_all.sh`, `run_s3.sh`, `run_vortex.sh`, `run_rust.sh`, `summarize.py`, `compare_storage.py`, `compare_formats.py`, `scripts/timescaledb.sh`) were removed after those runs. Recover them with `git checkout 2d66939 -- bench/`.
