"""Regression tests for the v0 report and the TimescaleDB loader."""

from __future__ import annotations

import datetime as dt
from typing import TYPE_CHECKING
from unittest.mock import MagicMock

import pyarrow as pa
import pyarrow.csv as pacsv
import pyarrow.parquet as pq
import pytest
import summarize
import tsdb_cloud

if TYPE_CHECKING:
    from pathlib import Path


def ingest_record(storage: str, target: str | None, seconds: float) -> dict[str, object]:
    record: dict[str, object] = {"system": "timelake", "storage": storage, "phase": "ingest", "seconds": seconds}
    if target:
        record["target"] = target
    return record


def test_ingest_records_of_s3_targets_stay_apart() -> None:
    """B16: S3 Standard and S3 Express both have storage "s3"; keying by storage dropped one of them."""
    records = [ingest_record("s3", None, 1.0), ingest_record("s3", "s3x", 2.0)]
    assert set(summarize.latest_ingest_records(records)) == {
        ("timelake", "s3", "ingest"),
        ("timelake", "s3x", "ingest"),
    }


def test_latest_ingest_record_wins() -> None:
    records = [ingest_record("local", None, 1.0), ingest_record("local", None, 2.0)]
    assert summarize.latest_ingest_records(records)[("timelake", "local", "ingest")]["seconds"] == 2.0


def test_csv_export_round_trips(tmp_path: Path) -> None:
    """B15: the export runs in-process, so a read error raises instead of ending the COPY stream early."""
    table = pa.table(
        {
            "time": pa.array([dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)] * 3, pa.timestamp("us", tz="UTC")),
            "name": ["", "b,c", None],  # a comma, and NULL vs empty string
            "value": [1.5, None, 3.0],
        }
    )
    pq.write_table(table, tmp_path / "t.parquet")
    csv = b"".join(tsdb_cloud.csv_chunks(tmp_path / "t.parquet", batch_rows=2))
    # As PostgreSQL reads CSV: an unquoted empty field is NULL, a quoted one an empty string.
    read = pacsv.ReadOptions(column_names=table.column_names)
    convert = pacsv.ConvertOptions(strings_can_be_null=True, quoted_strings_can_be_null=False)
    assert pacsv.read_csv(pa.py_buffer(csv), read_options=read, convert_options=convert).cast(table.schema) == table


def test_csv_export_fails_on_a_broken_file(tmp_path: Path) -> None:
    (tmp_path / "t.parquet").write_bytes(b"not parquet")
    with pytest.raises(pa.ArrowInvalid):
        list(tsdb_cloud.csv_chunks(tmp_path / "t.parquet"))


def fake_connection(answers: dict[str, object]) -> MagicMock:
    """A connection whose ``execute(sql).fetchone()`` answers by the first matching SQL fragment."""

    def execute(sql: str) -> MagicMock:
        result = MagicMock()
        result.fetchone.return_value = next((v,) for k, v in answers.items() if k in sql)
        return result

    conn = MagicMock()
    conn.execute.side_effect = execute
    return conn


def test_untiered_chunks_uses_is_tiered() -> None:
    conn = fake_connection({"column_name = 'is_tiered'": 1, "NOT is_tiered": 4})
    assert tsdb_cloud.untiered_chunks(conn) == 4


def test_untiered_chunks_falls_back_to_the_tiering_queue() -> None:
    conn = fake_connection({"column_name = 'is_tiered'": 0, "to_regclass": True, "chunks_queued_for_tiering": 2})
    assert tsdb_cloud.untiered_chunks(conn) == 2


def test_untiered_chunks_fails_when_tiering_is_not_visible() -> None:
    """B15: the wait used to end at once when the is_tiered column was missing."""
    conn = fake_connection({"column_name = 'is_tiered'": 0, "to_regclass": False})
    with pytest.raises(RuntimeError, match="tiered"):
        tsdb_cloud.untiered_chunks(conn)
