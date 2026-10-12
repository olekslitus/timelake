#!/usr/bin/env bash
# Runs every suite on every engine, one at a time (never in parallel, so runs don't compete for cores).
set -u
cd "$(dirname "$0")"
PY=.venv/bin/python
rm -f results/*.jsonl
for engine in duckdb datafusion polars duckdb-iceberg; do
  $PY run.py --suite tsbs_iot --engine "$engine" --runs 3 --timeout 300
done
for suite in tpch clickbench; do
  for engine in duckdb datafusion polars; do
    $PY run.py --suite "$suite" --engine "$engine" --runs 3 --timeout 300
  done
done
