"""Fixtures: a fresh warehouse per test and a small IoT readings table."""

from __future__ import annotations

import datetime as dt
from typing import TYPE_CHECKING

import pyarrow as pa
import pytest

import timelake

if TYPE_CHECKING:
    from pathlib import Path

START = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
SCHEMA = pa.schema([("time", pa.timestamp("us", tz="UTC")), ("device", pa.int32()), ("value", pa.float64())])


def readings(start: dt.datetime = START, minutes: int = 60, devices: int = 5, value: float = 1.0) -> pa.Table:
    """One row per minute and device; ``value`` grows by one per minute."""
    rows = [(start + dt.timedelta(minutes=m), d, value + m) for m in range(minutes) for d in range(devices)]
    times, device_ids, values = zip(*rows, strict=True)
    return pa.table({"time": times, "device": device_ids, "value": values}, schema=SCHEMA)


@pytest.fixture
def lake(tmp_path: Path) -> timelake.Lake:
    return timelake.Lake(str(tmp_path / "warehouse"))


@pytest.fixture
def table(lake: timelake.Lake) -> timelake.Table:
    """An empty time-series table ``iot.readings``."""
    return lake.create_table("iot.readings", SCHEMA, time_column="time", series_key=["device"])
