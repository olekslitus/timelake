#!/usr/bin/env bash
# TSBS IoT suites and the v0 benchmark from this machine against real S3 in us-east-2 (bench/infra stack,
# buckets only: bench/infra/up.sh). Latency includes the trip from here to the region; request counts and
# request cost don't depend on where the client runs. Needs: aws login --profile timelake.
#   bench/run_aws.sh                 everything (several hours; keeps the machine awake)
#   bench/run_aws.sh queries         one step: data | s3tables-ingest | queries | v0-local | v0-s3 | s3tables-rest
# Results: results/*.laptop-*.jsonl and results/v0_ingest.laptop.jsonl; summary: compare_aws.py.
set -euo pipefail
cd "$(dirname "$0")"
source infra/env.sh
PY=.venv/bin/python
bucket=$(output DataBucket)
export BENCH_TABLE_BUCKET_ARN=$(output TableBucketArn)
export BENCH_MACHINE="laptop (M1 Pro) to S3 us-east-2 over the internet"
export BENCH_ICEBERG_S3_DIR=iceberg-aws V0_INGEST_LOG=v0_ingest.laptop.jsonl TTFB_MS=0

# Counting proxy on :59100 and an uncounted one on :59000 for setup work, both in AWS mode.
proxy() {
  pkill -f '.bin/s3proxy' || true
  sleep 1
  nohup .bin/s3proxy -aws-bucket "$bucket" -listen :59100 -admin :59101 -ttfb 0ms >> data/s3proxy-aws.log 2>&1 &
  nohup .bin/s3proxy -aws-bucket "$bucket" -listen :59000 -admin :59001 -ttfb 0ms >> data/s3proxy-aws-setup.log 2>&1 &
  until curl -sf localhost:59101/stats > /dev/null && curl -sf localhost:59001/stats > /dev/null; do sleep 0.2; done
}

data() {
  for d in tsbs/parquet-sorted tsbs/vortex-sorted; do aws s3 sync "data/$d" "s3://$bucket/$d" --only-show-errors; done
  $PY scripts/tsbs_to_iceberg.py s3   # through the uncounted proxy, so paths are s3://bench/...
}

v0_ingest() {  # v0_ingest <target name> <storage> <systems...>
  local name=$1 storage=$2
  shift 2
  for s in "$@"; do BENCH_S3_NAME=$name $PY v0/ingest.py --system "$s" --storage "$storage" | tail -1; done
}

v0_queries() {  # v0_queries <target name> <storage> <phase> <engines>
  BENCH_S3_NAME=$1 V0_TAG=v0-laptop-$1 ENGINES=$4 v0/run_queries.sh "$2" "$3"
}

queries() {
  for t in local s3; do
    local tag=laptop-$t
    rm -f results/*."$tag".jsonl
    for engine in duckdb duckdb-iceberg duckdb-vortex datafusion polars datafusion-rs datafusion-rs-vortex; do
      for suite in tsbs_iot iot_point; do
        $PY run.py --runs 3 --timeout 300 --storage $t --tag $tag --layout sorted --suite $suite --engine $engine
      done
    done
  done
}

v0_all() {  # v0_all <target name> <storage>
  local engines="v0-iceberg v0-lance-duckdb v0-lance-df v0-timelake v0-timelake-duckdb"
  rm -f results/*.v0-laptop-"$1"-*.jsonl
  v0_ingest "$1" "$2" iceberg lance timelake
  v0_queries "$1" "$2" ingested "$engines"
  for s in iceberg lance timelake; do BENCH_S3_NAME=$1 $PY v0/ingest.py --system $s --storage "$2" --maintain-only | tail -1; done
  v0_queries "$1" "$2" maintained "$engines"
}

step() {
  echo "== $1 $(date -u +%FT%TZ)"
  case $1 in
    data) proxy; data ;;
    # Ingest into S3 Tables first: its managed compaction runs on its own schedule, so the clock starts early.
    s3tables-ingest) proxy; rm -f results/*.v0-laptop-aws-s3tables-*.jsonl; v0_ingest aws-s3tables s3 s3tables ;;
    queries) proxy; queries ;;
    v0-local) v0_all local local ;;
    v0-s3) proxy; v0_all aws-s3 s3 ;;
    s3tables-rest)  # queries on the ingested snapshot, wait for managed compaction, queries again
      proxy
      v0_queries aws-s3tables s3 ingested v0-s3tables
      BENCH_S3_NAME=aws-s3tables $PY v0/ingest.py --system s3tables --storage s3 --maintain-only | tail -3
      v0_queries aws-s3tables s3 maintained v0-s3tables
      ;;
    *) echo "unknown step $1"; exit 2 ;;
  esac
  echo "== $1 done $(date -u +%FT%TZ)"
}

if [ $# -gt 0 ]; then
  step "$1"
else
  for s in data s3tables-ingest queries v0-local v0-s3 s3tables-rest; do
    caffeinate -i bash "$0" "$s" || echo "== $s FAILED"
  done
  pkill -f '.bin/s3proxy' || true
fi
