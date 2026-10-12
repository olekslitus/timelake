#!/usr/bin/env bash
# Parquet vs Vortex through the Rust reader (DataFusion 55 + vortex-datafusion 0.88), local disk and
# RustFS at 20 ms TTFB. Parquet runs twice: DataFusion defaults, and with filter pushdown enabled
# (Vortex pushes filters into the scan by default).
set -u
cd "$(dirname "$0")"
PY=.venv/bin/python
ENGINES=(datafusion-rs datafusion-rs-pushdown datafusion-rs-vortex)
run() { $PY run.py --runs 3 --timeout 300 "$@"; }

rm -f results/*.rs-*.jsonl
for e in "${ENGINES[@]}"; do
  for suite in tpch clickbench; do run --suite "$suite" --engine "$e" --tag rs-local; done
  for layout in as-is sorted; do
    for suite in tsbs_iot iot_point; do run --suite "$suite" --engine "$e" --layout "$layout" --tag "rs-local-$layout"; done
  done
done

curl -sf -X POST "localhost:59101/ttfb?ms=20" || { echo "proxy not running"; exit 1; }
for e in "${ENGINES[@]}"; do
  for suite in tpch clickbench; do run --suite "$suite" --engine "$e" --storage s3 --tag rs-s3; done
  for suite in tsbs_iot iot_point; do run --suite "$suite" --engine "$e" --storage s3 --layout sorted --tag rs-s3-sorted; done
done
