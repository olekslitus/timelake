"""The shared benchmark helpers."""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

from benchlib.queries import DATAFUSION, DUCKDB, apply_dialect, raw_queries
from benchlib.results import append_jsonl, best_time, geomean, load_ok, order_engines, read_jsonl
from benchlib.v0 import Target

if TYPE_CHECKING:
    from pathlib import Path


def test_geomean() -> None:
    assert math.isclose(geomean([1.0, 4.0]), 2.0)


def test_geomean_clamps_tiny_times() -> None:
    assert math.isclose(geomean([0.0, 1e-4]), 1e-4)


def test_geomean_of_nothing_is_nan() -> None:
    assert math.isnan(geomean([]))


def test_best_time_skips_the_first_run() -> None:
    assert best_time({"times": [0.1, 0.5, 0.4]}) == 0.4


def test_best_time_of_a_single_run() -> None:
    assert best_time({"times": [0.3]}) == 0.3


def test_order_engines_puts_unknown_last() -> None:
    assert order_engines(["mystery", "v0-timelake", "duckdb"]) == ["duckdb", "v0-timelake", "mystery"]


def test_jsonl_round_trip(tmp_path: Path) -> None:
    path = tmp_path / "out" / "r.jsonl"
    append_jsonl(path, {"a": 1})
    append_jsonl(path, {"a": 2})
    assert read_jsonl(path) == [{"a": 1}, {"a": 2}]


def test_read_jsonl_of_missing_file_is_empty(tmp_path: Path) -> None:
    assert read_jsonl(tmp_path / "missing.jsonl") == []


def test_load_ok_skips_failures(tmp_path: Path) -> None:
    path = tmp_path / "r.jsonl"
    append_jsonl(path, {"engine": "duckdb", "query": "q1", "status": "ok", "times": [1.0]})
    append_jsonl(path, {"engine": "duckdb", "query": "q2", "status": "timeout"})
    assert list(load_ok(path)["duckdb"]) == ["q1"]


def test_apply_dialect_duckdb() -> None:
    assert apply_dialect("SELECT @B1H(time)", DUCKDB) == "SELECT time_bucket(INTERVAL '1 hour', time)"


def test_apply_dialect_datafusion_timestamp() -> None:
    assert apply_dialect("@TS('2026-01-01')", DATAFUSION) == "CAST('2026-01-01' AS TIMESTAMP)"


def test_every_tsbs_query_is_fully_translated() -> None:
    assert all("@" not in apply_dialect(sql, DUCKDB) for _, sql in raw_queries("tsbs_iot"))


def test_s3_tables_live_in_the_bench_bucket() -> None:
    assert Target("s3", "s3").root("timelake") == "s3://bench/v0/timelake"


def test_local_target_keeps_tables_on_disk() -> None:
    assert Target("local", "local").root("lance").endswith("data/v0/local/lance/lake")
