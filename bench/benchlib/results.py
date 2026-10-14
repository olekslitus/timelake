"""Result records (``results/*.jsonl``, one JSON object per line) and the statistics the reports use."""

from __future__ import annotations

import datetime as dt
import json
import statistics
from typing import TYPE_CHECKING, Any, TypedDict, cast

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping
    from pathlib import Path


class QueryRecord(TypedDict, total=False):
    """One query on one engine (``results/<suite>[.<tag>].jsonl``), written by ``run.py`` and ``v0/tsdb_cloud.py``."""

    suite: str
    engine: str
    version: str
    machine: str
    storage: str
    layout: str
    ts: str
    query: str
    direct: bool
    status: str
    """``ok``, ``error`` or ``timeout``."""
    error: str
    times: list[float]
    """Seconds per run: the first run, then the repeats."""
    rows: int | None
    setup_s: float
    requests: list[int]
    """S3 requests per run (through the counting proxy)."""
    bytes: list[int]
    ttfb_ms: int
    kinds: list[dict[str, int]]
    """S3 requests by kind, per run."""
    kinds_total: dict[str, int]
    """S3 requests by kind over all runs, for engines that don't report them per run."""
    rtt_ms: float
    server_ms: list[float]


class IngestRecord(TypedDict, total=False):
    """One v0 ingest or maintenance run (``results/v0_ingest*.jsonl``), written by ``v0/ingest.py``."""

    system: str
    storage: str
    phase: str
    """``ingest`` or ``maintain``."""
    window_minutes: int
    commits: int
    rows: int
    seconds: float
    commit_ms_p50: float
    commit_ms_p95: float
    commit_ms_max: float
    objects: int | None
    bytes: int
    data_files: int
    data_bytes: int
    inline_compactions: int
    compaction_after_ingest_s: dict[str, int]
    target: str
    """The storage target when it differs from ``storage`` (e.g. ``s3x``, ``aws-s3``)."""
    machine: str


ENGINE_ORDER = (
    "duckdb",
    "duckdb-iceberg",
    "duckdb-vortex",
    "datafusion",
    "datafusion-rs",
    "datafusion-rs-vortex",
    "polars",
    "v0-iceberg",
    "v0-s3tables",
    "v0-lance-duckdb",
    "v0-lance-df",
    "v0-timelake",
    "v0-timelake-duckdb",
)
"""The order engines appear in in reports; others go last."""


def order_engines(engines: Iterable[str]) -> list[str]:
    """Sorts engines into report order."""
    return sorted(engines, key=lambda e: ENGINE_ORDER.index(e) if e in ENGINE_ORDER else len(ENGINE_ORDER))


def utc_timestamp() -> str:
    """The current time for a record's ``ts``, e.g. ``2026-10-13T09:30:00+00:00``."""
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    """All records of a JSONL file; none if it doesn't exist."""
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def append_jsonl(path: Path, record: Mapping[str, object]) -> None:
    """Appends one record, creating the file (and its directory) if needed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        f.write(json.dumps(record) + "\n")


def load_ok(path: Path) -> dict[str, dict[str, QueryRecord]]:
    """Successful query records by engine, then query; a later record of the same query wins."""
    out: dict[str, dict[str, QueryRecord]] = {}
    for r in read_jsonl(path):
        if r["status"] == "ok":
            out.setdefault(r["engine"], {})[r["query"]] = cast("QueryRecord", r)
    return out


def geomean(xs: Iterable[float]) -> float:
    """Geometric mean, NaN if empty. Times under 0.1 ms count as 0.1 ms so one tiny value can't dominate."""
    clamped = [max(x, 1e-4) for x in xs]
    return statistics.geometric_mean(clamped) if clamped else float("nan")


def first_time(r: QueryRecord) -> float:
    """Seconds of the first run."""
    return r["times"][0]


def best_time(r: QueryRecord) -> float:
    """Seconds of the fastest repeat run (the first run if there were no repeats)."""
    return min(r["times"][1:] or r["times"])
