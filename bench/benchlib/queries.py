"""Query suites (``queries/``) and the SQL dialect placeholders of the TSBS suites."""

from __future__ import annotations

import re
from collections.abc import Iterator, Mapping

from benchlib import QUERIES

SUITES = ("tpch", "clickbench", "tsbs_iot", "iot_point")
TSBS_SUITES = ("tsbs_iot", "iot_point")
"""Suites over the TSBS tables, written with dialect placeholders."""

Dialect = Mapping[str, str]
"""Placeholder name -> format string with the placeholder's argument as ``{0}``."""

DUCKDB: Dialect = {
    "B10M": "time_bucket(INTERVAL '10 minutes', {})",
    "B1D": "time_bucket(INTERVAL '24 hours', {})",  # '1 day' takes DuckDB's ~130x slower calendar path on timestamptz
    "B1H": "time_bucket(INTERVAL '1 hour', {})",
    "EPOCH": "epoch({})",
    "TS": "TIMESTAMPTZ {}",
}
DATAFUSION: Dialect = {
    "B10M": "date_bin(INTERVAL '10 minutes', {})",
    "B1D": "date_bin(INTERVAL '24 hours', {})",
    "B1H": "date_bin(INTERVAL '1 hour', {})",
    "EPOCH": "date_part('epoch', {})",
    "TS": "CAST({} AS TIMESTAMP)",
}
POLARS: Dialect = {
    # Polars SQL has no time bucketing and can't compare tz-aware timestamps with literals, so `time` is
    # exposed as naive UTC (run.setup_polars) and buckets are integer arithmetic on epoch microseconds.
    "B10M": "(CAST({0} AS BIGINT) - CAST({0} AS BIGINT) % 600000000)",
    "B1D": "(CAST({0} AS BIGINT) - CAST({0} AS BIGINT) % 86400000000)",
    "B1H": "(CAST({0} AS BIGINT) - CAST({0} AS BIGINT) % 3600000000)",
    "EPOCH": "(CAST({0} AS BIGINT) / 1000000.0)",
    "TS": "CAST({0} AS TIMESTAMP)",
}
TIMESCALEDB: Dialect = {
    # v0/tsdb_cloud.py; the session runs with TimeZone = UTC.
    "B10M": "time_bucket('10 minutes', {})",
    "B1D": "time_bucket('1 day', {})",
    "B1H": "time_bucket('1 hour', {})",
    "EPOCH": "extract(epoch from {})",
    "TS": "TIMESTAMPTZ {}",
}

_PLACEHOLDER = re.compile(r"@(B10M|B1D|B1H|EPOCH|TS)\(([^()]*)\)")  # arguments contain no nested parentheses


def apply_dialect(sql: str, dialect: Dialect) -> str:
    """Replaces the placeholders (``@B1H(time)``, ...) with one engine's SQL."""
    return _PLACEHOLDER.sub(lambda m: dialect[m.group(1)].format(m.group(2)), sql)


def raw_queries(suite: str) -> Iterator[tuple[str, str]]:
    """``(name, sql)`` of a ``-- name:``-delimited suite, with comments removed and placeholders kept."""
    text = (QUERIES / suite / "queries.sql").read_text()
    for block in re.split(r"^-- name: ", text, flags=re.MULTILINE)[1:]:
        name, _, sql = block.partition("\n")
        body = "\n".join(line for line in sql.splitlines() if not line.startswith("--"))
        yield name.strip(), body.strip().rstrip(";")


def clickbench_queries(variant: str) -> list[tuple[str, str]]:
    """ClickBench queries named ``q00``... from one engine variant's file (one query per line)."""
    lines = (QUERIES / "clickbench" / f"{variant}_queries.sql").read_text().strip().splitlines()
    return [(f"q{i:02d}", q) for i, q in enumerate(lines)]
