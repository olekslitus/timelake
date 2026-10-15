"""The benchmark harness end to end on a tiny workload, on the local disk (no network, no generator)."""

from __future__ import annotations

import datetime as dt
from typing import TYPE_CHECKING, ClassVar, override

import pyarrow as pa
import pyarrow.csv as pacsv
import pytest

from timebench import harness, targets
from timebench.report import Run, markdown
from timebench.results import QueryRecord, read_jsonl
from timebench.systems.timescaledb import csv_chunks, pg_type
from timebench.targets import Target
from timebench.workloads import Batch, Query, TableSpec, Workload

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

START = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
SCHEMA = pa.schema([("time", pa.timestamp("us", tz="UTC")), ("device", pa.int32()), ("value", pa.float64())])


class Tiny(Workload):
    """Two devices, one reading a minute for two days, arriving an hour at a time."""

    name = "tiny"
    title = "Tiny"
    scales: ClassVar[dict[str, str]] = {"one": "2 devices, 2 days"}
    default_scale = "one"
    namespace = "tiny"
    tables = (TableSpec("devices"), TableSpec("readings", "time", ("device",)))
    suites = ()

    @override
    def prepare(self) -> None:
        pass

    @override
    def schema(self, table: str) -> pa.Schema:
        return pa.schema([("id", pa.int32()), ("name", pa.string())]) if table == "devices" else SCHEMA

    @override
    def initial(self) -> Iterator[Batch]:
        yield "devices", pa.table({"id": pa.array([1, 2], pa.int32()), "name": ["a", "b"]})

    @override
    def stream(self) -> Iterator[list[Batch]]:
        for hour in range(48):
            times = [START + dt.timedelta(hours=hour, minutes=m) for m in range(60)]
            yield [
                (
                    "readings",
                    pa.table(
                        {
                            "time": pa.array(times * 2, pa.timestamp("us", tz="UTC")),
                            "device": pa.array([1] * 60 + [2] * 60, pa.int32()),
                            "value": [float(hour)] * 120,
                        },
                        schema=SCHEMA,
                    ),
                )
            ]

    @override
    def queries(self) -> list[Query]:
        return [
            Query("tiny", "count", "SELECT count(*) AS n FROM readings"),
            Query(
                "tiny",
                "per-device",
                "SELECT d.name, avg(r.value) FROM readings r JOIN devices d ON d.id = r.device GROUP BY d.name",
            ),
            Query("tiny", "last-hour", "SELECT * FROM readings WHERE time >= @TS('2026-01-02 23:00:00')"),
        ]


@pytest.fixture
def bench_dirs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Run files and tables under a temporary directory."""
    monkeypatch.setattr(targets, "LAKES", tmp_path / "lakes")
    monkeypatch.setenv("BENCH_LAKES", str(tmp_path / "lakes"))  # for the query processes
    monkeypatch.setattr(harness, "RUNS", tmp_path / "runs")
    return tmp_path


@pytest.mark.usefixtures("bench_dirs")
@pytest.mark.parametrize("system", ["timelake", "iceberg", "lance", "parquet"])
def test_a_run_ingests_maintains_and_queries(system: str) -> None:
    spec = harness.RunSpec(
        workload=Tiny(), target=Target("local"), systems=[system], readers=["duckdb", "datafusion"], runs=1
    )
    records = read_jsonl(harness.run(spec))
    kinds = [r["kind"] for r in records]
    assert kinds[0] == "run"
    assert kinds[-1] == "end"
    header = records[0]
    assert header["workload"] == "tiny"
    assert header["target"] == "local"
    assert len(header["commit"]) == 40
    ingest = next(r for r in records if r["kind"] == "ingest")
    assert ingest["status"] == "ok", ingest
    assert ingest["commits"] == 48
    assert ingest["rows"] == 48 * 120
    assert next(r for r in records if r["kind"] == "maintain")["status"] == "ok"
    queries = [r for r in records if r["kind"] == "query"]
    assert {q["checkpoint"] for q in queries} == {"ingested", "maintained"}
    assert all(q["status"] == "ok" for q in queries), [q.get("error") for q in queries]
    counts = {(q["checkpoint"], q["query"], q["reader"]): q["rows"] for q in queries}
    assert all(n == 120 for (_, name, _), n in counts.items() if name == "last-hour")
    assert records[-1]["mismatches"] == []
    report = markdown(Run(harness.RUNS / f"{header['id']}.jsonl"))
    assert "## Queries, maintained" in report


def test_mismatches_name_the_readers_that_disagree() -> None:
    def record(system: str, rows: int) -> QueryRecord:
        return {
            "system": system,
            "reader": "duckdb",
            "checkpoint": "ingested",
            "query": "q",
            "status": "ok",
            "rows": rows,
        }

    assert harness.mismatches([record("a", 1), record("b", 1)]) == []
    assert harness.mismatches([record("a", 1), record("b", 2)]) == ["ingested/q: a+duckdb=1, b+duckdb=2"]


def test_pg_types() -> None:
    assert pg_type(pa.timestamp("us", tz="UTC")) == "timestamptz"
    assert pg_type(pa.int32()) == "integer"
    with pytest.raises(TypeError):
        pg_type(pa.list_(pa.int32()))


def test_csv_for_copy_round_trips() -> None:
    """NULL vs empty string, and a comma inside a value, survive the CSV that COPY reads."""
    table = pa.table(
        {
            "time": pa.array([START] * 3, pa.timestamp("us", tz="UTC")),
            "name": ["", "b,c", None],
            "value": [1.5, None, 3.0],
        }
    )
    csv = b"".join(csv_chunks(table, batch_rows=2))
    # As PostgreSQL reads CSV: an unquoted empty field is NULL, a quoted one an empty string.
    read = pacsv.ReadOptions(column_names=table.column_names)
    convert = pacsv.ConvertOptions(strings_can_be_null=True, quoted_strings_can_be_null=False)
    assert pacsv.read_csv(pa.py_buffer(csv), read_options=read, convert_options=convert).cast(table.schema) == table
