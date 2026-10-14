"""TimescaleDB on Tiger Cloud: the same TSBS IoT data and queries as the v0 benchmark, in three
states of one service: a plain hypertable (row store + index), the columnstore (compressed), and
tiered storage (chunks moved to S3 by Tiger's tiering).

    export TSDB_DSN=postgres://...           # a disposable benchmark service, never production
    python v0/tsdb_cloud.py load             # create hypertables, COPY the Parquet data in
    python v0/tsdb_cloud.py run hypertable   # 12 TSBS IoT + 5 single-truck queries
    python v0/tsdb_cloud.py columnstore      # convert all chunks to the columnstore
    python v0/tsdb_cloud.py run columnstore
    python v0/tsdb_cloud.py tier             # tier all chunks (tiered storage must be enabled in the Console)
    python v0/tsdb_cloud.py run tiered

Results: results/tsdb_cloud.jsonl. Client times are measured from this machine and include the
network round trip; `server_ms` subtracts the median round trip of `SELECT 1` measured just before.
"""

import json
import os
import platform
import statistics
import subprocess
import sys
import time
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import run  # noqa: E402

BENCH = Path(__file__).resolve().parent.parent
PARQUET = BENCH / "data" / "tsbs" / "parquet"
RESULTS = BENCH / "results" / "tsdb_cloud.jsonl"
DSN = os.environ["TSDB_DSN"]
TABLES = ["tags", "readings", "diagnostics"]

DDL = """
DROP TABLE IF EXISTS readings, diagnostics, tags CASCADE;
CREATE TABLE tags (id integer PRIMARY KEY, name text, fleet text, driver text, model text, device_version text,
                   load_capacity double precision, fuel_capacity double precision, nominal_fuel_consumption double precision);
CREATE TABLE readings (time timestamptz NOT NULL, tags_id integer, latitude double precision, longitude double precision,
                       elevation double precision, velocity double precision, heading double precision, grade double precision,
                       fuel_consumption double precision);
CREATE TABLE diagnostics (time timestamptz NOT NULL, tags_id integer, fuel_state double precision, current_load double precision,
                          status double precision);
SELECT create_hypertable('readings', by_range('time', INTERVAL '12 hours'));
SELECT create_hypertable('diagnostics', by_range('time', INTERVAL '12 hours'));
"""
# TSBS's TimescaleDB loader indexes (tags_id, time DESC) on both tables.
INDEXES = """
CREATE INDEX ON readings (tags_id, time DESC);
CREATE INDEX ON diagnostics (tags_id, time DESC);
ANALYZE;
"""


def connect():
    c = psycopg.connect(DSN, autocommit=True)
    c.execute("SET TimeZone = 'UTC'")
    return c


def load():
    with connect() as c:
        c.execute(DDL)
    for t in TABLES:
        t0 = time.perf_counter()
        # DuckDB streams the Parquet file as CSV straight into COPY.
        export = subprocess.Popen(
            [
                sys.executable,
                "-c",
                f"import duckdb; duckdb.sql(\"SET TimeZone='UTC'; SET enable_progress_bar=false\"); "
                f"duckdb.sql(\"COPY (SELECT * FROM '{PARQUET / (t + '.parquet')}') TO '/dev/stdout' (FORMAT csv, HEADER false)\")",
            ],
            stdout=subprocess.PIPE,
        )
        with connect() as c, c.cursor() as cur, cur.copy(f"COPY {t} FROM STDIN (FORMAT csv)") as cp:
            while chunk := export.stdout.read(1 << 20):
                cp.write(chunk)
        export.wait()
        print(f"{t}: loaded in {time.perf_counter() - t0:.0f}s", flush=True)
    with connect() as c:
        c.execute(INDEXES)
        print(sizes(c))


def sizes(c) -> dict:
    out = {}
    for t in ("readings", "diagnostics"):
        out[t] = c.execute(f"SELECT pg_size_pretty(hypertable_size('{t}'))").fetchone()[0]
    out["chunks"] = c.execute("SELECT count(*) FROM timescaledb_information.chunks").fetchone()[0]
    return out


def columnstore():
    with connect() as c:
        for t in ("readings", "diagnostics"):
            c.execute(
                f"ALTER TABLE {t} SET (timescaledb.enable_columnstore, timescaledb.segmentby = 'tags_id', timescaledb.orderby = 'time DESC')"
            )
            t0 = time.perf_counter()
            for (chunk,) in c.execute(f"SELECT show_chunks('{t}')").fetchall():
                c.execute(f"CALL convert_to_columnstore('{chunk}')")
            print(f"{t}: columnstore in {time.perf_counter() - t0:.0f}s", flush=True)
        c.execute("ANALYZE")
        print(sizes(c))


def tier():
    with connect() as c:
        for t in ("readings", "diagnostics"):
            t0 = time.perf_counter()
            for (chunk,) in c.execute(f"SELECT show_chunks('{t}')").fetchall():
                c.execute(f"SELECT tier_chunk('{chunk}')")
            print(f"{t}: tier_chunk issued for all chunks in {time.perf_counter() - t0:.0f}s", flush=True)
        # Tiering runs in the background; wait until no chunk is left in the database.
        while True:
            left = (
                c.execute(
                    "SELECT count(*) FROM timescaledb_information.chunks WHERE hypertable_name IN ('readings','diagnostics') AND NOT is_tiered"
                ).fetchone()[0]
                if has_is_tiered(c)
                else None
            )
            print(f"chunks not yet tiered: {left}", flush=True)
            if not left:
                break
            time.sleep(15)


def has_is_tiered(c) -> bool:
    return (
        c.execute(
            "SELECT count(*) FROM information_schema.columns WHERE table_schema='timescaledb_information' AND table_name='chunks' AND column_name='is_tiered'"
        ).fetchone()[0]
        > 0
    )


def rtt_ms(c) -> float:
    xs = []
    for _ in range(9):
        t = time.perf_counter()
        c.execute("SELECT 1").fetchall()
        xs.append((time.perf_counter() - t) * 1000)
    return statistics.median(xs)


def bench(state: str, runs: int = 2):
    engine = f"tsdb-{state}"
    with connect() as c:
        version = c.execute("SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'").fetchone()[0]
    for suite in ("tsbs_iot", "iot_point"):
        for name, raw in raw_queries(suite):
            sql = run.apply_dialect(raw, run.TSBS_DIALECT["tsdb"])
            # A fresh connection per query, like the other engines' fresh processes.
            with connect() as c:
                if state == "tiered":
                    c.execute("SET timescaledb.enable_tiered_reads = true")
                rtt = rtt_ms(c)
                times, rows, status, err = [], None, "ok", None
                try:
                    for _ in range(runs + 1):
                        t = time.perf_counter()
                        rows = len(c.execute(sql).fetchall())
                        times.append(time.perf_counter() - t)
                except Exception as e:  # noqa: BLE001
                    status, err = "error", str(e).splitlines()[0][:300]
            rec = {
                "suite": suite,
                "engine": engine,
                "query": name,
                "status": status,
                "times": times,
                "rows": rows,
                "rtt_ms": round(rtt, 1),
                "server_ms": [round(t * 1000 - rtt, 1) for t in times],
                "storage": "tiger-cloud",
                "version": f"timescaledb{version}",
                "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "machine": f"client {platform.machine()}",
            }
            if err:
                rec["error"] = err
            with RESULTS.open("a") as f:
                f.write(json.dumps(rec) + "\n")
            if status == "ok":
                print(
                    f"{engine:18} {name:36} first {times[0]:.3f}s best {min(times[1:] or times):.3f}s (rtt {rtt:.0f} ms) rows {rows}",
                    flush=True,
                )
            else:
                print(f"{engine:18} {name:36} ERROR {err}", flush=True)


def raw_queries(suite: str):
    """Queries with placeholders still in them (run.load_queries applies an engine dialect)."""
    import re

    text = (run.QUERIES / suite / "queries.sql").read_text()
    for block in re.split(r"^-- name: ", text, flags=re.M)[1:]:
        name, _, sql = block.partition("\n")
        yield name.strip(), "\n".join(l for l in sql.splitlines() if not l.startswith("--")).strip().rstrip(";")


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "load":
        load()
    elif cmd == "columnstore":
        columnstore()
    elif cmd == "tier":
        tier()
    elif cmd == "run":
        bench(sys.argv[2])
    elif cmd == "sizes":
        with connect() as c:
            print(sizes(c))
