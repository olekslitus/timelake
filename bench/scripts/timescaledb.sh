#!/usr/bin/env bash
# TimescaleDB baseline for the TSBS IoT suite, using TSBS's own loader and query runner.
# Same dataset as the lake engines (same seed/scale/time range). Runs in a throwaway container on
# port 55432 that is removed at the end. Results are appended to results/tsbs_iot.jsonl as engine
# "timescaledb", using the *median* latency over N randomized instances per query type (TSBS picks
# random fleets/windows per instance, unlike the fixed parameters of the lake port).
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=timelake-bench-tsdb
PORT=55432
PASS=bench
IMAGE=timescale/timescaledb:latest-pg17
N=${N:-20}
GEN=(--use-case=iot --seed=123 --scale=500 --timestamp-start=2026-01-01T00:00:00Z --timestamp-end=2026-01-04T00:00:00Z)
TYPES=(last-loc low-fuel high-load stationary-trucks long-driving-sessions long-daily-sessions
       avg-vs-projected-fuel-consumption avg-daily-driving-duration avg-daily-driving-session
       avg-load daily-activity breakdown-frequency)

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

cleanup
docker run -d --name "$NAME" -p "$PORT:5432" -e POSTGRES_PASSWORD="$PASS" --shm-size=1g "$IMAGE" >/dev/null
until docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
sleep 3

echo "== load"
time (.bin/tsbs_generate_data "${GEN[@]}" --log-interval=10s --format=timescaledb 2>/dev/null |
  .bin/tsbs_load_timescaledb --host=localhost --port="$PORT" --user=postgres --pass="$PASS" \
    --db-name=benchmark --workers=8 --batch-size=10000 --do-create-db=true 2>&1 | tail -4)
docker exec "$NAME" psql -U postgres -d benchmark -tAc \
  "SELECT 'db size: ' || pg_size_pretty(pg_database_size('benchmark'))"

VERSION=$(docker exec "$NAME" psql -U postgres -d benchmark -tAc \
  "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'")
QDIR=$(mktemp -d)
for t in "${TYPES[@]}"; do
  .bin/tsbs_generate_queries "${GEN[@]/--timestamp-end=2026-01-04T00:00:00Z/--timestamp-end=2026-01-04T00:00:01Z}" \
    --queries="$N" --query-type="$t" --format=timescaledb --file="$QDIR/$t.dat" 2>/dev/null
  out=$(.bin/tsbs_run_queries_timescaledb --file="$QDIR/$t.dat" --workers=1 --hosts=localhost --port="$PORT" \
    --user=postgres --pass="$PASS" --db-name=benchmark 2>&1)
  # TSBS prints e.g. "min:  12.34ms, med:  15.67ms, mean: ..." for the query type and for "all queries".
  med=$(echo "$out" | grep -m1 -o 'med: *[0-9.]*ms' | grep -o '[0-9.]*')
  echo "timescaledb $t median ${med}ms"
  .venv/bin/python - "$t" "$med" "$VERSION" <<'PY'
import json, sys, time, os, platform
q, med, ver = sys.argv[1], sys.argv[2], sys.argv[3]
rec = {"suite": "tsbs_iot", "engine": "timescaledb", "version": ver, "query": q,
       "machine": f"{platform.machine()} {os.cpu_count()} cores", "ts": time.strftime("%Y-%m-%dT%H:%M:%S")}
rec.update({"status": "ok", "times": [float(med) / 1000], "rows": None} if med else {"status": "error", "error": "no TSBS output"})
open("results/tsbs_iot.jsonl", "a").write(json.dumps(rec) + "\n")
PY
done
rm -rf "$QDIR"
