#!/usr/bin/env bash
# Query pass of the v0 benchmark over whatever state v0/ingest.py left (ingested or maintained).
#   v0/run_queries.sh local ingested
#   v0/run_queries.sh s3 maintained        # needs RustFS + proxy (bench/README.md), 20 ms TTFB
set -u
cd "$(dirname "$0")/.."
storage=$1 phase=$2 runs=${RUNS:-2}
tag="v0-$storage-$phase"
[ -z "${ENGINES:-}" ] && rm -f results/*."$tag".jsonl
if [ "$storage" = s3 ]; then curl -sf -X POST "localhost:59101/ttfb?ms=20" >/dev/null || { echo "proxy not running"; exit 1; }; fi
for engine in ${ENGINES:-v0-iceberg v0-lance-duckdb v0-lance-df v0-timelake v0-timelake-duckdb}; do
  for suite in tsbs_iot iot_point; do
    .venv/bin/python run.py --suite "$suite" --engine "$engine" --storage "$storage" --runs "$runs" --timeout 600 --tag "$tag"
  done
done
