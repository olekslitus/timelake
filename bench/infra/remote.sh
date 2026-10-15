#!/usr/bin/env bash
# Benchmark stages on the AWS instance (runs as ec2-user; start it with bench/infra/ssm.sh).
#
#   remote.sh build              Python env, Timelake (CLI + Python), Rust reader, s3proxy, TSBS generator
#   remote.sh data               generate the Phase 0 datasets, upload to S3, write Iceberg on S3, copy to S3 Express
#   remote.sh queries <target>   Phase 0 suites on local | s3 | s3x  (results tag aws-<target>)
#   remote.sh direct             plain DuckDB straight to S3 (no proxy), to measure the proxy's overhead
#   remote.sh bench <target>     timebench: TSBS IoT streamed into every lake system, queries before and after
#                                maintenance (results/runs)
#   remote.sh all                everything above, in order
#   remote.sh weekly             the weekly regression run (profiles/weekly.toml), started by weekly.sh
#
# Targets: local = the instance's disk (/mnt/bench: NVMe SSD if it has one, else EBS); s3 = S3 Standard; s3x = S3
# Express One Zone (same zone as the instance). S3 traffic goes through tools/s3proxy in AWS mode, which counts
# requests by kind. Logs and results are copied to s3://$BENCH_DATA_BUCKET/_out/ after every stage.
set -euo pipefail
SELF=$(realpath "$0")
source /etc/profile.d/timelake-bench.sh
export PATH=$HOME/.cargo/bin:$HOME/.local/bin:$PATH GOTOOLCHAIN=auto
# Amazon Linux's Go skips the module proxy and the checksum database: without the proxy, modules deleted from GitHub
# (a TSBS dependency) can't be fetched, and without the checksum database Go won't download the toolchain go.mod asks
# for.
export GOPROXY=https://proxy.golang.org,direct GOSUMDB=sum.golang.org
cd ~/timelake/bench
PY="uv run python"
LOGS=/mnt/bench/logs

sync_out() {
  aws s3 sync results "s3://$BENCH_DATA_BUCKET/_out/results" --exclude '*' --include '*aws*' --only-show-errors
  aws s3 sync results/runs "s3://$BENCH_DATA_BUCKET/_out/runs" --only-show-errors
  aws s3 sync "$LOGS" "s3://$BENCH_DATA_BUCKET/_out/logs" --only-show-errors
}

# Counting proxy on :59100 (admin :59101) and an uncounted one on :59000 for setup work (both in AWS mode).
proxy() {
  pkill -f '.bin/s3proxy' || true
  sleep 1
  nohup .bin/s3proxy -aws-bucket "$1" -listen :59100 -admin :59101 -ttfb 0ms >> "$LOGS/s3proxy.log" 2>&1 &
  nohup .bin/s3proxy -aws-bucket "$1" -listen :59000 -admin :59001 -ttfb 0ms >> "$LOGS/s3proxy-setup.log" 2>&1 &
  until curl -sf localhost:59101/stats > /dev/null && curl -sf localhost:59001/stats > /dev/null; do sleep 0.2; done
}

target() {
  case $1 in
    local) storage=local ;;
    s3) storage=s3; export BENCH_S3_NAME=s3; proxy "$BENCH_DATA_BUCKET" ;;
    s3x) storage=s3; export BENCH_S3_NAME=s3x; proxy "$BENCH_EXPRESS_BUCKET" ;;
    *) echo "unknown target $1"; exit 2 ;;
  esac
}

# What timebench needs: the Python environment (engines, timelake), the CLI, the proxy and the TSBS generator.
build_timebench() {
  export CARGO_PROFILE_RELEASE_DEBUG=false  # smaller, faster links on small instances
  uv sync  # Python (.python-version), the engines, and timelake built from crates/timelake-py
  (cd .. && cargo build --release -p timelake-cli)
  (cd tools/s3proxy && go build -o ../../.bin/s3proxy .)
  GOBIN=$PWD/.bin go install github.com/timescale/tsbs/cmd/tsbs_generate_data@v0.0.0-20260527045238-8323e59c7402  # pinned: the data must not change
}

build() {
  build_timebench
  (cd rust-reader && cargo build --release)  # the Phase 0 engine comparison (run.py)
}

data() {
  mkdir -p data/tsbs/parquet data/tpch data/clickbench
  # Same generators and seeds as Phase 0 (results/BASELINE.md, "Data generation").
  .bin/tsbs_generate_data --use-case=iot --seed=123 --scale=500 \
    --timestamp-start=2026-01-01T00:00:00Z --timestamp-end=2026-01-04T00:00:00Z \
    --log-interval=10s --format=timescaledb | $PY scripts/tsbs_to_parquet.py data/tsbs/parquet
  $PY scripts/tpch_to_parquet.py data/tpch --scale 10 --scratch /mnt/bench/tpch.duckdb
  for i in $(seq 0 9); do
    curl -fsSL -o data/clickbench/hits_$i.parquet \
      https://datasets.clickhouse.com/hits_compatible/athena_partitioned/hits_$i.parquet
  done
  $PY scripts/to_vortex.py
  $PY scripts/tsbs_to_iceberg.py
  for d in tpch clickbench tsbs/parquet tsbs/parquet-sorted tsbs/vortex tsbs/vortex-sorted; do
    aws s3 sync "data/$d" "s3://$BENCH_DATA_BUCKET/$d" --only-show-errors
  done
  proxy "$BENCH_DATA_BUCKET"
  $PY scripts/tsbs_to_iceberg.py s3   # writes through the uncounted proxy, so paths are s3://bench/...
  aws s3 sync "s3://$BENCH_DATA_BUCKET" "s3://$BENCH_EXPRESS_BUCKET" --exclude '_out/*' --only-show-errors
}

queries() {
  target "$1"
  local tag=aws-$1
  rm -f results/*."$tag".jsonl
  run() { $PY run.py --runs 3 --timeout 300 --storage "$storage" --tag "$tag" "$@"; }
  for engine in duckdb duckdb-iceberg duckdb-vortex datafusion polars datafusion-rs datafusion-rs-vortex; do
    for suite in tsbs_iot iot_point; do run --suite $suite --engine $engine --layout sorted; done
  done
  for suite in tpch clickbench; do
    for engine in duckdb duckdb-vortex datafusion polars datafusion-rs datafusion-rs-vortex; do
      run --suite $suite --engine $engine
    done
  done
}

direct() {
  rm -f results/*.aws-s3-direct.jsonl
  for suite in tsbs_iot iot_point tpch clickbench; do
    BENCH_S3_DIRECT=$BENCH_DATA_BUCKET $PY run.py --runs 3 --timeout 300 --storage s3 --tag aws-s3-direct \
      --suite $suite --engine duckdb --layout sorted
  done
}

bench() {
  target "$1"
  local name=aws-$1 systems=timelake,iceberg,lance,parquet
  [ "$1" = local ] && name=local
  # Lance 13 finds the latest version from listing order, and S3 Express listings are unsorted, so it reads stale
  # versions there (an append is invisible to a fresh reader). Not benchmarked on s3x.
  [ "$1" = s3x ] && systems=timelake,iceberg,parquet
  uv run timebench run tsbs-iot --target "$name" --systems "$systems" --ttfb-ms 0
}

# TimescaleDB for the weekly run, in a container on this instance (its data on the instance's disk). The version is
# pinned so that changes in the history are ours; move it deliberately.
timescaledb() {
  docker rm -f bench-timescaledb > /dev/null 2>&1 || true
  docker run -d --name bench-timescaledb -p 55432:5432 -e POSTGRES_PASSWORD=bench -e POSTGRES_DB=bench \
    -v /mnt/bench/timescaledb:/var/lib/postgresql timescale/timescaledb:2.30.2-pg18 > /dev/null
  # Over TCP: the server that initializes the database listens on the socket only, then restarts.
  until docker exec bench-timescaledb pg_isready -q -h 127.0.0.1 -U postgres; do sleep 1; done
  export BENCH_TIMESCALEDB_DSN=postgresql://postgres:bench@localhost:55432/bench
}

weekly() {
  sudo shutdown -h +360  # a safety net: weekly.sh stops the instance when the run is done
  build_timebench
  timescaledb
  uv run timebench profile weekly --target local
  target s3
  uv run timebench profile weekly --target aws-s3
  docker rm -f bench-timescaledb > /dev/null
}

stage() {
  local name=$*
  name=${name// /-}
  echo "== $name $(date -u +%FT%TZ)"
  rm -f "$LOGS/$name".{done,failed}
  # A fresh bash process, so set -e stops the stage at its first failing command (bash ignores -e inside
  # functions called from `if`, `&&` or `||`).
  if ! bash "$SELF" _run "$@"; then touch "$LOGS/$name.failed"; sync_out; return 1; fi
  touch "$LOGS/$name.done"
  echo "== $name done $(date -u +%FT%TZ)"
  sync_out
}

case ${1:-} in
  _run) shift; "$@" ;;
  all)
    stage build && stage data || exit 1
    for s in "queries local" "queries s3" "queries s3x" direct "bench local" "bench s3" "bench s3x"; do
      stage $s || true  # later stages don't depend on each other
    done
    ;;
  build | data | direct | weekly) stage "$1" ;;
  queries | bench) stage "$1" "$2" ;;
  *) sed -n '2,16p' "$SELF"; exit 2 ;;
esac
