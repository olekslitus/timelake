"""Baseline benchmark runner for Timelake (SPEC.md §17).

Runs a query suite on one engine. Each query runs in a fresh subprocess: one "first" run, then
`--runs` repeat runs. Each run fully materializes the result as Arrow. Results are appended to
results/<suite>.jsonl.

    python run.py --suite tpch --engine duckdb
    python run.py --suite clickbench --engine datafusion --queries 0,1,2
"""

import argparse
import json
import os
import platform
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).parent
DATA = ROOT / "data"
QUERIES = ROOT / "queries"
RESULTS = ROOT / "results"

# --storage s3 reads everything through the latency/counting proxy (tools/s3proxy): the local RustFS, or on AWS
# (bench/infra) a real S3 or S3 Express bucket that the proxy re-signs for. Clients see the same s3://bench paths.
S3 = {
    "endpoint": "localhost:59100",
    "admin": "http://localhost:59101",
    "key": "benchkey",
    "secret": "benchsecret123",
    "region": "us-east-1",
}
STORAGE = "local"
# On AWS, BENCH_S3_DIRECT=<bucket> makes plain DuckDB read that bucket directly (instance credentials, no proxy),
# to check the proxy's overhead. No request counts in that mode.
DIRECT = os.environ.get("BENCH_S3_DIRECT")


def base() -> str:
    if STORAGE == "s3":
        return f"s3://{DIRECT}" if DIRECT else "s3://bench"
    return str(DATA)


def proxy_stats() -> dict:
    import urllib.request

    with urllib.request.urlopen(f"{S3['admin']}/stats") as r:
        return json.load(r)


TPCH_TABLES = ["lineitem", "orders", "customer", "part", "partsupp", "supplier", "nation", "region"]
TSBS_TABLES = ["tags", "readings", "diagnostics"]

# Engine-specific replacements for the TSBS placeholders (see queries/tsbs_iot/queries.sql).
TSBS_DIALECT = {
    "duckdb": {
        "B10M": "time_bucket(INTERVAL '10 minutes', {})",
        "B1D": "time_bucket(INTERVAL '24 hours', {})",  # '1 day' takes DuckDB's ~130x slower calendar path on timestamptz
        "B1H": "time_bucket(INTERVAL '1 hour', {})",
        "EPOCH": "epoch({})",
        "TS": "TIMESTAMPTZ {}",
    },
    "datafusion": {
        "B10M": "date_bin(INTERVAL '10 minutes', {})",
        "B1D": "date_bin(INTERVAL '24 hours', {})",
        "B1H": "date_bin(INTERVAL '1 hour', {})",
        "EPOCH": "date_part('epoch', {})",
        "TS": "CAST({} AS TIMESTAMP)",
    },
    # Polars SQL has no time bucketing and can't compare tz-aware timestamps with literals, so `time`
    # is exposed as naive UTC (setup_polars) and buckets are integer arithmetic on epoch microseconds.
    "polars": {
        "B10M": "(CAST({0} AS BIGINT) - CAST({0} AS BIGINT) % 600000000)",
        "B1D": "(CAST({0} AS BIGINT) - CAST({0} AS BIGINT) % 86400000000)",
        "B1H": "(CAST({0} AS BIGINT) - CAST({0} AS BIGINT) % 3600000000)",
        "EPOCH": "(CAST({0} AS BIGINT) / 1000000.0)",
        "TS": "CAST({0} AS TIMESTAMP)",
    },
}
TSBS_DIALECT["duckdb-iceberg"] = TSBS_DIALECT["duckdb"]
# TimescaleDB / Tiger Cloud (v0/tsdb_cloud.py). The session runs with TimeZone = UTC.
TSBS_DIALECT["tsdb"] = {
    "B10M": "time_bucket('10 minutes', {})",
    "B1D": "time_bucket('1 day', {})",
    "B1H": "time_bucket('1 hour', {})",
    "EPOCH": "extract(epoch from {})",
    "TS": "TIMESTAMPTZ {}",
}
TSBS_DIALECT["duckdb-vortex"] = TSBS_DIALECT["duckdb"]
# Rust reader (rust-reader/): DataFusion 55 over Parquet or Vortex.
RUST_ENGINES = {
    "datafusion-rs": ["--format", "parquet"],
    "datafusion-rs-pushdown": ["--format", "parquet", "--pushdown"],
    "datafusion-rs-vortex": ["--format", "vortex"],
}
RUST_BIN = ROOT / "rust-reader" / "target" / "release" / "bench-reader"
for _e in RUST_ENGINES:
    TSBS_DIALECT[_e] = TSBS_DIALECT["datafusion"]
# v0 benchmark (v0/README.md): the same TSBS tables streamed into each system by v0/ingest.py.
V0_ENGINES = {
    "v0-iceberg": "duckdb",  # DuckDB iceberg_scan over PyIceberg-appended tables (S3 Tables pattern)
    "v0-s3tables": "duckdb",  # the same over real S3 Tables tables (AWS)
    "v0-lance-duckdb": "duckdb",  # DuckDB over Lance datasets (pyarrow dataset interface)
    "v0-lance-df": "datafusion",  # DataFusion + Lance's own scanner (FFILanceTableProvider)
    "v0-timelake": "datafusion",  # Timelake reader (timelake CLI, DataFusion inside)
    "v0-timelake-duckdb": "duckdb",  # plain DuckDB iceberg_scan over Timelake tables
}
for _e, _d in V0_ENGINES.items():
    TSBS_DIALECT[_e] = TSBS_DIALECT[_d]
TIMELAKE_BIN = ROOT.parent / "target" / "release" / "timelake"
TSBS_SUITES = ("tsbs_iot", "iot_point")  # suites over the TSBS tables
LAYOUT = "as-is"  # TSBS tables: "as-is" (time order) or "sorted" by (tags_id, time)


def load_queries(suite: str, engine: str) -> list[tuple[str, str]]:
    if suite == "clickbench":
        name = (
            "datafusion-partitioned"
            if engine in ("datafusion", "polars", *RUST_ENGINES)
            else "duckdb-parquet-partitioned"
        )
        lines = (QUERIES / "clickbench" / f"{name}_queries.sql").read_text().strip().splitlines()
        return [(f"q{i:02d}", q) for i, q in enumerate(lines)]
    text = (QUERIES / suite / "queries.sql").read_text()
    out = []
    for block in re.split(r"^-- name: ", text, flags=re.M)[1:]:
        name, _, sql = block.partition("\n")
        sql = "\n".join(l for l in sql.splitlines() if not l.startswith("--")).strip().rstrip(";")
        if suite in TSBS_SUITES:
            sql = apply_dialect(sql, TSBS_DIALECT[engine])
        out.append((name.strip(), sql))
    return out


def apply_dialect(sql: str, dialect: dict[str, str]) -> str:
    def repl(m: re.Match) -> str:
        return dialect[m.group(1)].format(m.group(2))

    # Placeholder arguments contain no nested parentheses.
    return re.sub(r"@(B10M|B1D|B1H|EPOCH|TS)\(([^()]*)\)", repl, sql)


# ---------------------------------------------------------------------------- engine setup (worker side)


def tsbs_dir(fmt: str) -> str:
    return f"{fmt}-sorted" if LAYOUT == "sorted" else fmt


def setup_duckdb(suite: str, iceberg: bool = False, vortex: bool = False):
    import duckdb

    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")  # bucket by UTC days like the other engines (and avoid ICU calendar math)
    if STORAGE == "s3" and DIRECT:
        con.execute("INSTALL httpfs; LOAD httpfs; INSTALL aws; LOAD aws")
        con.execute(f"CREATE SECRET (TYPE s3, PROVIDER credential_chain, REGION '{os.environ['AWS_REGION']}')")
    elif STORAGE == "s3":
        con.execute("INSTALL httpfs; LOAD httpfs")
        con.execute(
            f"CREATE SECRET (TYPE s3, KEY_ID '{S3['key']}', SECRET '{S3['secret']}', REGION '{S3['region']}', "
            f"ENDPOINT '{S3['endpoint']}', URL_STYLE 'path', USE_SSL false)"
        )
    if vortex:
        if STORAGE == "s3":
            # The vortex extension reads S3 through its own Rust object_store client, not httpfs secrets.
            os.environ.update(
                AWS_ACCESS_KEY_ID=S3["key"],
                AWS_SECRET_ACCESS_KEY=S3["secret"],
                AWS_REGION=S3["region"],
                AWS_ENDPOINT=f"http://{S3['endpoint']}",
                AWS_ALLOW_HTTP="true",
            )
        con.execute("INSTALL vortex; LOAD vortex")
        if suite == "tpch":
            for t in TPCH_TABLES:
                con.execute(f"CREATE VIEW {t} AS SELECT * FROM read_vortex('{base()}/tpch/vortex/{t}.vortex')")
        elif suite in TSBS_SUITES:
            for t in TSBS_TABLES:
                path = f"{base()}/tsbs/{tsbs_dir('vortex')}/{t}.vortex"
                con.execute(f"CREATE VIEW {t} AS SELECT * FROM read_vortex('{path}')")
        elif suite == "clickbench":
            create = (QUERIES / "clickbench" / "duckdb-parquet-partitioned_create.sql").read_text()
            create = create.replace(
                "read_parquet('hits_*.parquet', binary_as_string=True)",
                f"read_vortex('{base()}/clickbench/vortex/*.vortex')",
            )
            con.execute(create)
    elif suite == "tpch":
        for t in TPCH_TABLES:
            con.execute(f"CREATE VIEW {t} AS SELECT * FROM read_parquet('{base()}/tpch/{t}.parquet')")
    elif suite in TSBS_SUITES:
        if iceberg:
            con.execute("INSTALL iceberg; LOAD iceberg")
            meta_dir = os.environ.get("BENCH_ICEBERG_S3_DIR", "iceberg-s3") if STORAGE == "s3" else "iceberg"
            meta = json.loads((DATA / "tsbs" / meta_dir / "metadata.json").read_text())
            for t in TSBS_TABLES:
                con.execute(f"CREATE VIEW {t} AS SELECT * FROM iceberg_scan('{meta[t]}')")
        else:
            for t in TSBS_TABLES:
                path = f"{base()}/tsbs/{tsbs_dir('parquet')}/{t}.parquet"
                con.execute(f"CREATE VIEW {t} AS SELECT * FROM read_parquet('{path}')")
    elif suite == "clickbench":
        create = (QUERIES / "clickbench" / "duckdb-parquet-partitioned_create.sql").read_text()
        # "*.parquet", not "hits_*": S3 Express rejects list prefixes that don't end in "/". Same 10 files.
        con.execute(create.replace("'hits_*.parquet'", f"'{base()}/clickbench/*.parquet'"))
    return lambda sql: con.execute(sql).fetch_arrow_table()


def setup_datafusion(suite: str):
    from datafusion import SessionContext

    ctx = SessionContext()
    if STORAGE == "s3":
        from datafusion.object_store import AmazonS3

        store = AmazonS3(
            bucket_name="bench",
            region=S3["region"],
            access_key_id=S3["key"],
            secret_access_key=S3["secret"],
            endpoint=f"http://{S3['endpoint']}",
            allow_http=True,
        )
        ctx.register_object_store("s3://", store, "bench")
    if suite == "tpch":
        for t in TPCH_TABLES:
            ctx.register_parquet(t, f"{base()}/tpch/{t}.parquet")
    elif suite in TSBS_SUITES:
        for t in TSBS_TABLES:
            ctx.register_parquet(t, f"{base()}/tsbs/{tsbs_dir('parquet')}/{t}.parquet")
    elif suite == "clickbench":
        create = (QUERIES / "clickbench" / "datafusion-partitioned_create.sql").read_text()
        create = create.replace("LOCATION 'partitioned'", f"LOCATION '{base()}/clickbench/'")
        for stmt in filter(str.strip, create.split(";")):
            ctx.sql(stmt).collect()
    return lambda sql: ctx.sql(sql).to_arrow_table()


def setup_polars(suite: str):
    import polars as pl

    opts = (
        {
            "aws_access_key_id": S3["key"],
            "aws_secret_access_key": S3["secret"],
            "aws_region": S3["region"],
            "aws_endpoint_url": f"http://{S3['endpoint']}",
            "aws_allow_http": "true",
        }
        if STORAGE == "s3"
        else None
    )
    ctx = pl.SQLContext()
    if suite == "tpch":
        for t in TPCH_TABLES:
            ctx.register(t, pl.scan_parquet(f"{base()}/tpch/{t}.parquet", storage_options=opts))
    elif suite in TSBS_SUITES:
        for t in TSBS_TABLES:
            lf = pl.scan_parquet(f"{base()}/tsbs/{tsbs_dir('parquet')}/{t}.parquet", storage_options=opts)
            if t != "tags":
                lf = lf.with_columns(pl.col("time").dt.replace_time_zone(None))
            ctx.register(t, lf)
    elif suite == "clickbench":
        lf = pl.scan_parquet(f"{base()}/clickbench/*.parquet", storage_options=opts)
        schema = lf.collect_schema()
        casts = [pl.col(c).cast(pl.Utf8) for c, dt in schema.items() if dt == pl.Binary]
        lf = lf.with_columns(*casts, pl.col("EventDate").cast(pl.Int32).cast(pl.Date))
        ctx.register("hits", lf)
    return lambda sql: ctx.execute(sql, eager=True).to_arrow()


def v0_state(system: str) -> dict:
    sys.path.insert(0, str(ROOT / "v0"))
    from common import load_state

    return load_state(STORAGE, system)["tables"]


def setup_v0(engine: str):
    tables = v0_state(
        {"v0-iceberg": "iceberg", "v0-s3tables": "s3tables", "v0-timelake-duckdb": "timelake"}.get(engine, "lance")
    )
    if engine in ("v0-iceberg", "v0-s3tables", "v0-timelake-duckdb"):
        import duckdb

        con = duckdb.connect()
        con.execute("SET TimeZone = 'UTC'")
        con.execute("INSTALL iceberg; LOAD iceberg")
        if STORAGE == "s3":
            con.execute("INSTALL httpfs; LOAD httpfs")
            con.execute(
                f"CREATE SECRET (TYPE s3, KEY_ID '{S3['key']}', SECRET '{S3['secret']}', REGION '{S3['region']}', "
                f"ENDPOINT '{S3['endpoint']}', URL_STYLE 'path', USE_SSL false)"
            )
        for t in TSBS_TABLES:
            con.execute(f"CREATE VIEW {t} AS SELECT * FROM iceberg_scan('{tables[t]}')")
        return lambda sql: con.execute(sql).fetch_arrow_table()
    import lance

    sys.path.insert(0, str(ROOT / "v0"))
    from common import LANCE_S3

    opts = LANCE_S3 if STORAGE == "s3" else None
    ds = {t: lance.dataset(tables[t], storage_options=opts) for t in TSBS_TABLES}
    if engine == "v0-lance-duckdb":
        import duckdb

        con = duckdb.connect()
        con.execute("SET TimeZone = 'UTC'")
        for t, d in ds.items():
            con.register(t, d)
        return lambda sql: con.execute(sql).fetch_arrow_table()
    from datafusion import SessionContext

    ctx = SessionContext()
    for t, d in ds.items():
        ctx.register_table(t, lance.FFILanceTableProvider(d))
    return lambda sql: ctx.sql(sql).to_arrow_table()


def worker(suite: str, engine: str, name: str, runs: int):
    sql = dict(load_queries(suite, engine))[name]
    setup_start = time.perf_counter()
    if engine == "duckdb":
        run = setup_duckdb(suite)
    elif engine == "duckdb-iceberg":
        run = setup_duckdb(suite, iceberg=True)
    elif engine == "duckdb-vortex":
        run = setup_duckdb(suite, vortex=True)
    elif engine == "datafusion":
        run = setup_datafusion(suite)
    elif engine == "polars":
        run = setup_polars(suite)
    elif engine in V0_ENGINES:
        run = setup_v0(engine)
    else:
        raise ValueError(engine)
    setup_s = time.perf_counter() - setup_start
    times, requests, nbytes, rows = [], [], [], None
    counted = STORAGE == "s3" and not DIRECT
    kinds = []
    for _ in range(runs + 1):
        before = proxy_stats() if counted else None
        t = time.perf_counter()
        result = run(sql)
        times.append(time.perf_counter() - t)
        rows = result.num_rows
        if before:
            after = proxy_stats()
            requests.append(after["requests"] - before["requests"])
            nbytes.append(after["bytes"] - before["bytes"])
            if "kinds" in after:  # AWS mode: requests by kind (GET, HEAD, LIST, PUT, ...)
                kinds.append(
                    {
                        k: n - before["kinds"].get(k, 0)
                        for k, n in after["kinds"].items()
                        if n != before["kinds"].get(k, 0)
                    }
                )
    out = {"times": times, "rows": rows, "setup_s": setup_s}
    if counted:
        out.update(requests=requests, bytes=nbytes, ttfb_ms=proxy_stats()["ttfb_ms"])
        if kinds:
            out["kinds"] = kinds
    print(json.dumps(out))


# ---------------------------------------------------------------------------- driver


def engine_version(engine: str) -> str:
    if engine in RUST_ENGINES:
        return "df55.2+vortex0.88"
    if engine == "v0-timelake":
        return "timelake0.0.1+df54.1"
    if engine.startswith("v0-lance"):
        return "lance" + __import__("lance").__version__
    if engine in V0_ENGINES:
        return "duckdb" + __import__("duckdb").__version__
    mod = {
        "duckdb": "duckdb",
        "duckdb-iceberg": "duckdb",
        "duckdb-vortex": "duckdb",
        "datafusion": "datafusion",
        "polars": "polars",
    }[engine]
    return __import__(mod).__version__


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--suite", required=True, choices=["tpch", "clickbench", "tsbs_iot", "iot_point"])
    p.add_argument(
        "--engine",
        required=True,
        choices=["duckdb", "duckdb-iceberg", "duckdb-vortex", "datafusion", "polars", *RUST_ENGINES, *V0_ENGINES],
    )
    p.add_argument("--layout", default="as-is", choices=["as-is", "sorted"], help="TSBS tables only")
    p.add_argument("--runs", type=int, default=3, help="repeat runs after the first run")
    p.add_argument("--timeout", type=int, default=300, help="seconds per query (all runs)")
    p.add_argument("--queries", help="comma-separated query names or ClickBench indexes")
    p.add_argument("--storage", default="local", choices=["local", "s3"], help="s3 = local RustFS via tools/s3proxy")
    p.add_argument("--tag", help="results go to results/<suite>.<tag>.jsonl")
    p.add_argument("--worker", help=argparse.SUPPRESS)
    a = p.parse_args()
    global STORAGE, LAYOUT
    STORAGE, LAYOUT = a.storage, a.layout

    if a.worker:
        return worker(a.suite, a.engine, a.worker, a.runs)

    queries = [n for n, _ in load_queries(a.suite, a.engine)]
    if a.queries:
        wanted = {q if not q.isdigit() else f"q{int(q):02d}" for q in a.queries.split(",")}
        queries = [q for q in queries if q in wanted]

    RESULTS.mkdir(exist_ok=True)
    out = RESULTS / (f"{a.suite}.{a.tag}.jsonl" if a.tag else f"{a.suite}.jsonl")
    meta = {
        "suite": a.suite,
        "engine": a.engine,
        "version": engine_version(a.engine),
        "machine": os.environ.get("BENCH_MACHINE") or f"{platform.machine()} {os.cpu_count()} cores",
        "storage": a.storage,
        "layout": a.layout,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    sqls = dict(load_queries(a.suite, a.engine))
    for name in queries:
        stdin = None
        if a.engine == "v0-timelake":
            sys.path.insert(0, str(ROOT / "v0"))
            from common import OBJECT_STORE_S3

            tl_root = v0_state("timelake")["root"]
            opts = [x for k, v in OBJECT_STORE_S3.items() for x in ("-o", f"{k}={v}")] if a.storage == "s3" else []
            cmd = [str(TIMELAKE_BIN), "-w", tl_root, *opts, "sql", "--namespace", "tsbs", "--bench-runs", str(a.runs)]
            if a.storage == "s3":
                cmd += ["--proxy-admin", S3["admin"].removeprefix("http://")]
            stdin = sqls[name]
        elif a.engine in RUST_ENGINES:
            cmd = [
                str(RUST_BIN),
                "--suite",
                a.suite,
                "--runs",
                str(a.runs),
                "--storage",
                a.storage,
                "--layout",
                a.layout,
                *RUST_ENGINES[a.engine],
            ]
            stdin = sqls[name]
        else:
            cmd = [
                sys.executable,
                __file__,
                "--suite",
                a.suite,
                "--engine",
                a.engine,
                "--runs",
                str(a.runs),
                "--storage",
                a.storage,
                "--layout",
                a.layout,
                "--worker",
                name,
            ]
        rec = {**meta, "query": name}
        if DIRECT:
            rec["direct"] = True
        before = proxy_stats() if a.storage == "s3" and not DIRECT else None
        try:
            proc = subprocess.run(cmd, input=stdin, capture_output=True, text=True, timeout=a.timeout)
            if proc.returncode == 0:
                rec.update(json.loads(proc.stdout.strip().splitlines()[-1]), status="ok")
            else:
                lines = proc.stderr.strip().splitlines() or ["?"]
                err = next((l for l in reversed(lines) if "Error" in l or "Exception" in l), lines[-1])
                rec.update(status="error", error=err[:300])
        except subprocess.TimeoutExpired:
            rec.update(status="timeout")
        if before and "kinds" in before:
            # Requests by kind over all runs of this query, for engines that don't report them per run (Rust, Timelake CLI).
            after = proxy_stats()
            total = {
                k: n - before["kinds"].get(k, 0) for k, n in after["kinds"].items() if n != before["kinds"].get(k, 0)
            }
            if total:
                rec["kinds_total"] = total
        with out.open("a") as f:
            f.write(json.dumps(rec) + "\n")
        if rec["status"] == "ok":
            first, hot = rec["times"][0], min(rec["times"][1:] or rec["times"])
            reqs = f"  reqs {rec['requests'][0]}/{min(rec['requests'])}" if "requests" in rec else ""
            print(
                f"{a.engine:15} {a.suite:10} {name:36} first {first:8.3f}s  best {hot:8.3f}s  rows {rec['rows']}{reqs}"
            )
        else:
            print(f"{a.engine:15} {a.suite:10} {name:36} {rec['status'].upper()}: {rec.get('error', '')[:120]}")


if __name__ == "__main__":
    main()
