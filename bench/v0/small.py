r"""A small Timelake benchmark for any S3-compatible store, with no proxy.

The first N five-minute windows of TSBS IoT are appended as commits (two per window), then four queries run, each once
in a fresh `Lake` (cold) and twice more (warm). Small enough for free tiers (100 commits: about 1,000 writes, under
1,000 reads, 35 MB). Prints one JSON line.

    BENCH_URL=s3://bucket/run-1 BENCH_OPTIONS='{"aws_endpoint": "https://t3.storage.dev", "aws_region": "auto"}' \
        uv run python v0/small.py --label tigris --windows 50

Credentials come from the usual environment variables (`AWS_ACCESS_KEY_ID`, ...). `BENCH_URL` must be a new prefix.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import time

import numpy as np
import pyarrow.parquet as pq
from ingest import windows  # next to this script

import timelake
from benchlib import DATA, TSBS_TIME_SERIES

QUERIES = {
    "one-truck-latest": "SELECT time, latitude, longitude FROM readings WHERE tags_id = 1 ORDER BY time DESC LIMIT 1",
    "last-loc": """
        SELECT t.name, t.driver, r.longitude, r.latitude FROM tags t
        JOIN (SELECT tags_id, longitude, latitude, ROW_NUMBER() OVER (PARTITION BY tags_id ORDER BY time DESC) AS rn
              FROM readings) r ON r.tags_id = t.id AND r.rn = 1
        WHERE t.name IS NOT NULL AND t.fleet = 'South'""",
    "one-truck-history": "SELECT time, velocity FROM readings WHERE tags_id = 1 ORDER BY time",
    "fleet-avg-velocity": "SELECT tags_id, avg(velocity) FROM readings GROUP BY tags_id",
}


def main() -> None:
    """Appends, queries, and prints the timings as JSON."""
    parser = argparse.ArgumentParser(description="Small Timelake benchmark for an S3-compatible store.")
    parser.add_argument("--label", required=True, help="name of the store in the output")
    parser.add_argument("--windows", type=int, default=50, help="five-minute windows to append (two commits each)")
    args = parser.parse_args()
    url, options = os.environ["BENCH_URL"], json.loads(os.environ.get("BENCH_OPTIONS", "{}"))

    lake = timelake.Lake(url, storage_options=options)
    source = {n: pq.read_table(DATA / "tsbs" / "parquet" / f"{n}.parquet") for n in ("tags", *TSBS_TIME_SERIES)}
    lake.create_table("tsbs.tags", source["tags"].schema).append(source["tags"])
    tables = {
        n: lake.create_table(f"tsbs.{n}", source[n].schema, time_column="time", series_key=["tags_id"], dedup=False)
        for n in TSBS_TIME_SERIES
    }
    latencies: list[float] = []
    for batches in zip(*(windows(source[n], 5)[: args.windows] for n in TSBS_TIME_SERIES), strict=True):
        for name, batch in zip(TSBS_TIME_SERIES, batches, strict=True):
            started = time.perf_counter()
            tables[name].append(batch)
            latencies.append(time.perf_counter() - started)

    queries: dict[str, dict[str, int]] = {}
    for name, sql in QUERIES.items():
        reader = timelake.Lake(url, storage_options=options)
        times = []
        for _ in range(3):
            started = time.perf_counter()
            reader.sql(sql, namespace="tsbs")
            times.append(time.perf_counter() - started)
        queries[name] = {"first_ms": round(times[0] * 1000), "best_ms": round(min(times[1:]) * 1000)}
    print(
        json.dumps(
            {
                "label": args.label,
                "commits": len(latencies),
                "commit_ms_p50": round(statistics.median(latencies) * 1000),
                "commit_ms_p95": round(float(np.percentile(latencies, 95)) * 1000),
                "queries": queries,
            }
        )
    )


if __name__ == "__main__":
    main()
