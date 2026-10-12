#!/usr/bin/env bash
# Full v0 benchmark: ingest → queries → maintenance → queries, on local disk and on RustFS (20 ms).
# SKIP_S3_INGEST="iceberg lance" reuses existing S3 ingests for those systems.
set -u
cd "$(dirname "$0")/.."
PY=.venv/bin/python
for storage in local s3; do
  if [ "$storage" = s3 ]; then curl -sf -X POST "localhost:59101/ttfb?ms=20" >/dev/null || { echo "proxy not running"; exit 1; }; fi
  for s in iceberg lance timelake; do
    if [ "$storage" = s3 ] && [[ " ${SKIP_S3_INGEST:-} " == *" $s "* ]]; then continue; fi
    $PY v0/ingest.py --system $s --storage $storage | tail -1
  done
  v0/run_queries.sh $storage ingested
  for s in iceberg lance timelake; do $PY v0/ingest.py --system $s --storage $storage --maintain-only | tail -1; done
  v0/run_queries.sh $storage maintained
done
