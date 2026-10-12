#!/usr/bin/env bash
# Parquet vs Vortex, same engine (DuckDB), same data and queries. Needs scripts/to_vortex.py output,
# and for the s3 pass, the RustFS container + proxy with the vortex files uploaded (README).
set -u
cd "$(dirname "$0")"
PY=.venv/bin/python
run() { $PY run.py --runs 3 --timeout 300 "$@"; }

# Local disk
rm -f results/*.fmt-local*.jsonl
for engine in duckdb duckdb-vortex; do
  for suite in tpch clickbench; do run --suite "$suite" --engine "$engine" --tag fmt-local; done
  for layout in as-is sorted; do
    run --suite tsbs_iot --engine "$engine" --layout "$layout" --tag "fmt-local-$layout"
  done
done
for layout in as-is sorted; do
  for engine in duckdb duckdb-vortex datafusion polars; do
    run --suite iot_point --engine "$engine" --layout "$layout" --tag "fmt-local-$layout"
  done
done

# RustFS with 20 ms time-to-first-byte
curl -sf -X POST "localhost:59101/ttfb?ms=20" || { echo "proxy not running"; exit 1; }
rm -f results/*.fmt-s3*.jsonl
for engine in duckdb duckdb-vortex; do
  for suite in tpch clickbench; do run --suite "$suite" --engine "$engine" --storage s3 --tag fmt-s3; done
  run --suite tsbs_iot --engine "$engine" --storage s3 --layout sorted --tag fmt-s3-sorted
  run --suite iot_point --engine "$engine" --storage s3 --layout sorted --tag fmt-s3-sorted
done
