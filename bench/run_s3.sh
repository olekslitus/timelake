#!/usr/bin/env bash
# Runs every suite against the local RustFS through tools/s3proxy, at 0 ms and 20 ms added
# time-to-first-byte per request. Requires the RustFS container, uploaded data, and a running proxy
# (see README "Object storage").
set -u
cd "$(dirname "$0")"
PY=.venv/bin/python
for ttfb in 0 20; do
  curl -sf -X POST "localhost:59101/ttfb?ms=$ttfb" || { echo "proxy not running"; exit 1; }
  tag="rustfs-${ttfb}ms"
  rm -f results/*."$tag".jsonl
  for engine in duckdb duckdb-iceberg datafusion polars; do
    $PY run.py --suite tsbs_iot --engine "$engine" --storage s3 --tag "$tag" --runs 3 --timeout 300
  done
  for suite in tpch clickbench; do
    for engine in duckdb datafusion polars; do
      $PY run.py --suite "$suite" --engine "$engine" --storage s3 --tag "$tag" --runs 3 --timeout 300
    done
  done
done
