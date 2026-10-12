"""Python API smoke test: python -m pytest crates/timelake-py/tests (needs duckdb, polars)."""

import datetime as dt

import duckdb
import polars as pl
import pyarrow as pa
import pytest

import timelake


def readings(start: dt.datetime, minutes: int, devices: int, value: float = 1.0) -> pa.Table:
    rows = [(start + dt.timedelta(minutes=m), d, value + m) for m in range(minutes) for d in range(devices)]
    return pa.table(
        {
            "time": pa.array([r[0] for r in rows], pa.timestamp("us", tz="UTC")),
            "device": pa.array([r[1] for r in rows], pa.int32()),
            "value": pa.array([r[2] for r in rows], pa.float64()),
        }
    )


def test_lifecycle(tmp_path):
    lake = timelake.Lake(str(tmp_path / "wh"))
    start = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
    first = readings(start, 60, 5)
    t = lake.create_table("iot.r", first.schema, time_column="time", series_key=["device"])
    with pytest.raises(Exception):
        lake.create_table("iot.r", first.schema, time_column="time")

    r = t.append(first, batch_id="b1")
    assert r["rows"] == 300 and not r["duplicate"]
    assert t.append(first, batch_id="b1")["duplicate"]
    # polars in, late data in another partition
    t.append(pl.from_arrow(readings(start - dt.timedelta(days=1), 10, 5, value=-1.0)))
    assert t.version == 3
    assert lake.tables() == ["iot.r"]

    out = lake.sql("SELECT count(*) AS n FROM r", namespace="iot")
    assert out.column("n")[0].as_py() == 350
    hourly = lake.sql("SELECT time_bucket(INTERVAL '1 hour', time) h, avg(value) v FROM iot.r GROUP BY 1 ORDER BY 1")
    assert hourly.num_rows == 2

    latest = lake.latest("iot.r").sort_by("device")
    assert latest.num_rows == 5 and latest.column("value")[0].as_py() == 60.0

    m = t.maintain()
    assert m["partitions_compacted"] == 0  # one file per partition already
    info = t.info()
    assert info["rows"] == 350 and info["files"] == 2 and info["series_key"] == ["device"]

    # Plain DuckDB reads the same table.
    con = duckdb.connect()
    con.execute("INSTALL iceberg; LOAD iceberg")
    n = con.sql(f"SELECT count(*) FROM iceberg_scan('{t.location}')").fetchone()[0]
    assert n == 350
    with pytest.raises(KeyError):
        lake.table("iot.missing")
