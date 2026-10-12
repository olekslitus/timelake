#!/usr/bin/env bash
# Re-run only the Timelake side of the v0 benchmark (after a Timelake change); other systems' results are kept.
set -u
cd "$(dirname "$0")/.."
PY=.venv/bin/python
export ENGINES="v0-timelake v0-timelake-duckdb"
$PY - <<'PYEOF'
import json, pathlib
for p in pathlib.Path("results").glob("*.v0-*.jsonl"):
    if p.name.startswith(("tsbs_iot", "iot_point")):
        keep = [l for l in p.read_text().splitlines() if l.strip() and json.loads(l)["engine"] not in ("v0-timelake", "v0-timelake-duckdb")]
        p.write_text("".join(l + "\n" for l in keep))
PYEOF
for storage in local s3; do
  if [ "$storage" = s3 ]; then curl -sf -X POST "localhost:59101/ttfb?ms=20" >/dev/null || exit 1; fi
  $PY v0/ingest.py --system timelake --storage $storage | tail -1
  v0/run_queries.sh $storage ingested
  $PY v0/ingest.py --system timelake --storage $storage --maintain-only | tail -1
  v0/run_queries.sh $storage maintained
done
