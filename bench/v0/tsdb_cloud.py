"""TimescaleDB on Tiger Cloud: the same TSBS IoT data and queries as the v0 benchmark.

Three states of one service: a plain hypertable (row store + index), the columnstore (compressed), and
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

from __future__ import annotations

import argparse
import io
import os
import platform
import statistics
import time
from typing import TYPE_CHECKING, LiteralString, cast

import psycopg
import pyarrow.csv as pacsv
import pyarrow.parquet as pq
from psycopg import sql

from benchlib import DATA, RESULTS, TSBS_TABLES, TSBS_TIME_SERIES
from benchlib.queries import TIMESCALEDB, TSBS_SUITES, apply_dialect, raw_queries
from benchlib.results import QueryRecord, append_jsonl, best_time, first_time, utc_timestamp

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from psycopg.abc import Query

PARQUET = DATA / "tsbs" / "parquet"
RESULTS_FILE = RESULTS / "tsdb_cloud.jsonl"
STATES = ("hypertable", "columnstore", "tiered")
TIERING_POLL_S = 15

DDL = """
DROP TABLE IF EXISTS readings, diagnostics, tags CASCADE;
CREATE TABLE tags (id integer PRIMARY KEY, name text, fleet text, driver text, model text, device_version text,
                   load_capacity double precision, fuel_capacity double precision,
                   nominal_fuel_consumption double precision);
CREATE TABLE readings (time timestamptz NOT NULL, tags_id integer, latitude double precision,
                       longitude double precision, elevation double precision, velocity double precision,
                       heading double precision, grade double precision, fuel_consumption double precision);
CREATE TABLE diagnostics (time timestamptz NOT NULL, tags_id integer, fuel_state double precision,
                          current_load double precision, status double precision);
SELECT create_hypertable('readings', by_range('time', INTERVAL '12 hours'));
SELECT create_hypertable('diagnostics', by_range('time', INTERVAL '12 hours'));
"""
# TSBS's TimescaleDB loader indexes (tags_id, time DESC) on both tables.
INDEXES = """
CREATE INDEX ON readings (tags_id, time DESC);
CREATE INDEX ON diagnostics (tags_id, time DESC);
ANALYZE;
"""


def connect(dsn: str) -> psycopg.Connection:
    """An autocommit connection with the session in UTC (like the other engines)."""
    conn = psycopg.connect(dsn, autocommit=True)
    conn.execute("SET TimeZone = 'UTC'")
    return conn


def fetch_value(conn: psycopg.Connection, query: Query) -> object:
    """The first column of the first row of a query."""
    row = conn.execute(query).fetchone()
    if row is None:
        msg = f"no rows from {query!r}"
        raise RuntimeError(msg)
    return row[0]


def fetch_count(conn: psycopg.Connection, query: Query) -> int:
    """The result of a ``SELECT count(*)``."""
    value = fetch_value(conn, query)
    if not isinstance(value, int):
        msg = f"expected a count from {query!r}, got {value!r}"
        raise TypeError(msg)
    return value


def csv_chunks(path: Path, batch_rows: int = 100_000) -> Iterator[bytes]:
    """A Parquet file as headerless CSV for ``COPY ... (FORMAT csv)``, one chunk per record batch.

    Runs in this process, so a read error raises instead of ending the stream early (which would load a
    partial table without notice).
    """
    options = pacsv.WriteOptions(include_header=False)
    for batch in pq.ParquetFile(path).iter_batches(batch_size=batch_rows):
        buffer = io.BytesIO()
        pacsv.write_csv(batch, buffer, options)
        yield buffer.getvalue()


def load(dsn: str) -> None:
    """Creates the hypertables and copies the Parquet data in."""
    with connect(dsn) as conn:
        conn.execute(DDL)
    for t in TSBS_TABLES:
        start = time.perf_counter()
        with (
            connect(dsn) as conn,
            conn.cursor() as cur,
            cur.copy(sql.SQL("COPY {} FROM STDIN (FORMAT csv)").format(sql.Identifier(t))) as copy,
        ):
            for chunk in csv_chunks(PARQUET / f"{t}.parquet"):
                copy.write(chunk)
        print(f"{t}: loaded in {time.perf_counter() - start:.0f}s", flush=True)
    with connect(dsn) as conn:
        conn.execute(INDEXES)
        print(sizes(conn))


def sizes(conn: psycopg.Connection) -> dict[str, object]:
    """Size of each hypertable and the number of chunks."""
    out = {
        t: fetch_value(conn, sql.SQL("SELECT pg_size_pretty(hypertable_size({}))").format(sql.Literal(t)))
        for t in TSBS_TIME_SERIES
    }
    out["chunks"] = fetch_value(conn, "SELECT count(*) FROM timescaledb_information.chunks")
    return out


def columnstore(dsn: str) -> None:
    """Converts every chunk to the columnstore, segmented by truck."""
    with connect(dsn) as conn:
        for t in TSBS_TIME_SERIES:
            alter = sql.SQL(
                "ALTER TABLE {} SET (timescaledb.enable_columnstore, timescaledb.segmentby = 'tags_id', "
                "timescaledb.orderby = 'time DESC')"
            )
            conn.execute(alter.format(sql.Identifier(t)))
            start = time.perf_counter()
            for (chunk,) in conn.execute(sql.SQL("SELECT show_chunks({})").format(sql.Literal(t))).fetchall():
                conn.execute(sql.SQL("CALL convert_to_columnstore({})").format(sql.Literal(chunk)))
            print(f"{t}: columnstore in {time.perf_counter() - start:.0f}s", flush=True)
        conn.execute("ANALYZE")
        print(sizes(conn))


def untiered_chunks(conn: psycopg.Connection) -> int:
    """Chunks of the benchmark tables still in the database.

    Tiger exposes this as ``timescaledb_information.chunks.is_tiered`` or, on other versions, as the queue
    ``timescaledb_osm.chunks_queued_for_tiering``. If neither exists that is an error, not "nothing left"
    (which used to end the wait at once).
    """
    has_is_tiered = fetch_count(
        conn,
        "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'timescaledb_information' "
        "AND table_name = 'chunks' AND column_name = 'is_tiered'",
    )
    if has_is_tiered:
        return fetch_count(
            conn,
            "SELECT count(*) FROM timescaledb_information.chunks "
            "WHERE hypertable_name IN ('readings', 'diagnostics') AND NOT is_tiered",
        )
    if fetch_value(conn, "SELECT to_regclass('timescaledb_osm.chunks_queued_for_tiering') IS NOT NULL"):
        return fetch_count(conn, "SELECT count(*) FROM timescaledb_osm.chunks_queued_for_tiering")
    msg = "can't tell which chunks are tiered: is tiered storage enabled for this service?"
    raise RuntimeError(msg)


def tier(dsn: str) -> None:
    """Tiers every chunk, then waits until tiering (which runs in the background) has moved them all."""
    with connect(dsn) as conn:
        for t in TSBS_TIME_SERIES:
            start = time.perf_counter()
            for (chunk,) in conn.execute(sql.SQL("SELECT show_chunks({})").format(sql.Literal(t))).fetchall():
                conn.execute(sql.SQL("SELECT tier_chunk({})").format(sql.Literal(chunk)))
            print(f"{t}: tier_chunk issued for all chunks in {time.perf_counter() - start:.0f}s", flush=True)
        while left := untiered_chunks(conn):
            print(f"chunks not yet tiered: {left}", flush=True)
            time.sleep(TIERING_POLL_S)
        print("all chunks tiered", flush=True)


def rtt_ms(conn: psycopg.Connection) -> float:
    """Median round trip of ``SELECT 1``."""
    times = []
    for _ in range(9):
        start = time.perf_counter()
        conn.execute("SELECT 1").fetchall()
        times.append((time.perf_counter() - start) * 1000)
    return statistics.median(times)


def run_query(conn: psycopg.Connection, query: str, runs: int) -> QueryRecord:
    """Runs a query ``runs + 1`` times; times, rows and status (a failed query is a result, not a crash)."""
    times: list[float] = []
    rows = None
    try:
        for _ in range(runs + 1):
            start = time.perf_counter()
            # The query text comes from queries/, so it is trusted SQL.
            rows = len(conn.execute(cast("LiteralString", query)).fetchall())
            times.append(time.perf_counter() - start)
    except psycopg.Error as e:
        return {"status": "error", "times": times, "rows": rows, "error": str(e).splitlines()[0][:300]}
    return {"status": "ok", "times": times, "rows": rows}


def bench(dsn: str, state: str, runs: int = 2) -> None:
    """Runs both TSBS suites, a fresh connection per query (like the other engines' fresh processes)."""
    engine = f"tsdb-{state}"
    with connect(dsn) as conn:
        version = fetch_value(conn, "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'")
    for suite in TSBS_SUITES:
        for name, raw in raw_queries(suite):
            query = apply_dialect(raw, TIMESCALEDB)
            with connect(dsn) as conn:
                if state == "tiered":
                    conn.execute("SET timescaledb.enable_tiered_reads = true")
                rtt = rtt_ms(conn)
                result = run_query(conn, query, runs)
            record: QueryRecord = {
                "suite": suite,
                "engine": engine,
                "query": name,
                "status": result["status"],
                "times": result["times"],
                "rows": result["rows"],
                "rtt_ms": round(rtt, 1),
                "server_ms": [round(t * 1000 - rtt, 1) for t in result["times"]],
                "storage": "tiger-cloud",
                "version": f"timescaledb{version}",
                "ts": utc_timestamp(),
                "machine": f"client {platform.machine()}",
            }
            if "error" in result:
                record["error"] = result["error"]
            append_jsonl(RESULTS_FILE, record)
            if record["status"] == "ok":
                print(
                    f"{engine:18} {name:36} first {first_time(record):.3f}s best {best_time(record):.3f}s "
                    f"(rtt {rtt:.0f} ms) rows {record['rows']}",
                    flush=True,
                )
            else:
                print(f"{engine:18} {name:36} ERROR {record['error']}", flush=True)


def main() -> None:
    """Runs one command."""
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = p.add_subparsers(dest="command", required=True)
    commands.add_parser("load", help="create hypertables and copy the data in")
    commands.add_parser("columnstore", help="convert all chunks to the columnstore")
    commands.add_parser("tier", help="tier all chunks and wait until they are")
    commands.add_parser("sizes", help="print table sizes")
    run = commands.add_parser("run", help="run the queries")
    run.add_argument("state", choices=STATES, help="the service's state, recorded as engine tsdb-<state>")
    args = p.parse_args()
    dsn = os.environ["TSDB_DSN"]
    if args.command == "load":
        load(dsn)
    elif args.command == "columnstore":
        columnstore(dsn)
    elif args.command == "tier":
        tier(dsn)
    elif args.command == "run":
        bench(dsn, args.state)
    elif args.command == "sizes":
        with connect(dsn) as conn:
            print(sizes(conn))


if __name__ == "__main__":
    main()
