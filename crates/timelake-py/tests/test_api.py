"""The Python API end to end on a local warehouse."""

import datetime as dt

import duckdb
import polars as pl
import pyarrow as pa
import pytest
from conftest import SCHEMA, START, readings

import timelake


def test_lake_location_is_a_url(lake: timelake.Lake) -> None:
    assert lake.location.startswith("file://")


def test_lake_repr_shows_location(lake: timelake.Lake) -> None:
    assert repr(lake) == f"Lake({lake.location!r})".replace("'", '"')


def test_new_table_is_at_version_one(table: timelake.Table) -> None:
    assert table.version == 1


def test_table_name_is_qualified(table: timelake.Table) -> None:
    assert table.name == "iot.readings"


def test_unqualified_table_goes_to_default_namespace(lake: timelake.Lake) -> None:
    assert lake.create_table("devices", SCHEMA).name == "default.devices"


def test_table_schema_round_trips(table: timelake.Table) -> None:
    assert table.schema.names == SCHEMA.names


def test_table_location_is_under_the_lake(lake: timelake.Lake, table: timelake.Table) -> None:
    assert table.location.startswith(lake.location)


def test_table_repr_shows_name_and_version(table: timelake.Table) -> None:
    assert repr(table) == "Table(iot.readings, v1)"


def test_create_table_accepts_an_object_with_a_schema(lake: timelake.Lake) -> None:
    assert lake.create_table("iot.copy", readings(), time_column="time").schema.names == SCHEMA.names


@pytest.mark.usefixtures("table")
def test_tables_lists_qualified_names(lake: timelake.Lake) -> None:
    lake.create_table("other.devices", SCHEMA)
    assert sorted(lake.tables()) == ["iot.readings", "other.devices"]


def test_drop_table_removes_it(lake: timelake.Lake, table: timelake.Table) -> None:
    lake.drop_table(table.name)
    assert lake.tables() == []


def test_table_opens_latest_version(lake: timelake.Lake, table: timelake.Table) -> None:
    table.append(readings())
    assert lake.table("iot.readings").version == table.version


def test_append_reports_rows(table: timelake.Table) -> None:
    assert table.append(readings())["rows"] == 300


def test_append_reports_new_version(table: timelake.Table) -> None:
    assert table.append(readings())["version"] == table.version


def test_append_advances_the_handle(table: timelake.Table) -> None:
    before = table.version
    table.append(readings())
    assert table.version == before + 1


def test_append_result_has_documented_keys(table: timelake.Table) -> None:
    result = table.append(readings(), maintain=False)
    assert set(result) == {"rows", "files", "bytes", "version", "commit_ms", "attempts", "duplicate"}


def test_append_with_new_batch_id_is_not_duplicate(table: timelake.Table) -> None:
    assert table.append(readings(), batch_id="b1")["duplicate"] is False


def test_append_with_repeated_batch_id_is_duplicate(table: timelake.Table) -> None:
    table.append(readings(), batch_id="b1")
    assert table.append(readings(), batch_id="b1")["duplicate"] is True


def test_duplicate_append_writes_nothing(lake: timelake.Lake, table: timelake.Table) -> None:
    table.append(readings(), batch_id="b1")
    table.append(readings(), batch_id="b1")
    assert lake.sql("SELECT count(*) AS n FROM iot.readings").to_pylist() == [{"n": 300}]


def test_append_accepts_polars(lake: timelake.Lake, table: timelake.Table) -> None:
    table.append(pl.from_arrow(readings()))
    assert lake.sql("SELECT count(*) AS n FROM iot.readings").to_pylist() == [{"n": 300}]


def test_append_accepts_record_batch(table: timelake.Table) -> None:
    assert table.append(readings().to_batches()[0])["rows"] == 300


def test_append_accepts_record_batch_reader(table: timelake.Table) -> None:
    data = readings()
    reader = pa.RecordBatchReader.from_batches(data.schema, data.to_batches())
    assert table.append(reader)["rows"] == 300


def test_append_casts_to_table_types(lake: timelake.Lake, table: timelake.Table) -> None:
    data = readings(minutes=1, devices=1).set_column(1, "device", pa.array([7], pa.int64()))
    table.append(data)
    assert lake.sql("SELECT device FROM iot.readings").column("device").type == pa.int32()


def test_append_fills_missing_nullable_column(lake: timelake.Lake, table: timelake.Table) -> None:
    table.append(readings(minutes=1, devices=1).drop_columns("value"))
    assert lake.sql("SELECT value FROM iot.readings").to_pylist() == [{"value": None}]


def test_refresh_sees_other_writers(lake: timelake.Lake, table: timelake.Table) -> None:
    other = lake.table("iot.readings")
    other.append(readings())
    table.refresh()
    assert table.version == other.version


def test_sql_resolves_unqualified_names_in_namespace(lake: timelake.Lake, table: timelake.Table) -> None:
    table.append(readings())
    assert lake.sql("SELECT count(*) AS n FROM readings", namespace="iot").to_pylist() == [{"n": 300}]


def test_sql_time_bucket(lake: timelake.Lake, table: timelake.Table) -> None:
    table.append(readings(minutes=120))
    hourly = lake.sql("SELECT time_bucket(INTERVAL '1 hour', time) AS h FROM iot.readings GROUP BY 1")
    assert hourly.num_rows == 2


def test_sql_returns_a_pyarrow_table(lake: timelake.Lake) -> None:
    assert isinstance(lake.sql("SELECT 1 AS one"), pa.Table)


def test_latest_has_one_row_per_series(lake: timelake.Lake, table: timelake.Table) -> None:
    table.append(readings())
    assert lake.latest("iot.readings").num_rows == 5


def test_latest_has_the_newest_values(lake: timelake.Lake, table: timelake.Table) -> None:
    table.append(readings())
    table.append(readings(START - dt.timedelta(days=1), minutes=10, value=-1.0))  # late data
    assert set(lake.latest("iot.readings").column("value").to_pylist()) == {60.0}


def test_maintain_compacts_partitions(table: timelake.Table) -> None:
    table.append(readings(), maintain=False)
    table.append(readings(START + dt.timedelta(hours=1)), maintain=False)
    assert table.maintain(expire=False)["partitions_compacted"] == 1


def test_maintain_report_has_documented_keys(table: timelake.Table) -> None:
    assert set(table.maintain()) == {
        "partitions_compacted",
        "files_rewritten",
        "files_written",
        "rows_rewritten",
        "duplicates_removed",
        "partitions_dropped",
        "snapshots_expired",
        "objects_deleted",
        "seconds",
    }


def test_upgrade_and_rollback(lake: timelake.Lake) -> None:
    # A table in the format Timelake 0.2 wrote, with two small files.
    table = lake.create_table(
        "iot.old", SCHEMA, time_column="time", series_key=["device"], properties={"timelake.format-version": "0.1.0"}
    )
    table.append(readings(), maintain=False)
    table.append(readings(START + dt.timedelta(hours=1)), maintain=False)
    version = table.info()["version"]

    plan = table.upgrade(dry_run=True)
    assert plan["steps"][0] == "set table format 0.1.0 → 0.2.0"
    assert table.info()["version"] == version
    report = table.upgrade()
    assert report["steps"] == plan["steps"]
    assert report["keep_snapshots_until_ms"] is not None
    assert table.info()["files"] == 1
    assert table.upgrade()["steps"] == []

    assert report["snapshot_before"] is not None
    table.rollback(report["snapshot_before"])
    assert table.info()["files"] == 2
    with pytest.raises(KeyError):
        table.rollback(12345)


def test_inline_maintenance_is_reported(lake: timelake.Lake) -> None:
    table = lake.create_table("iot.busy", SCHEMA, time_column="time", properties={"timelake.compact-min-files": "2"})
    results = [table.append(readings(START + dt.timedelta(hours=1), minutes=1)) for _ in range(4)]
    assert any("maintenance" in r for r in results)


def test_info_describes_contract(table: timelake.Table) -> None:
    info = table.info()
    assert (info["time_column"], info["series_key"], info["chunk"], info["dedup"]) == ("time", ["device"], "day", True)


def test_info_counts_rows_and_files(table: timelake.Table) -> None:
    table.append(readings())
    table.append(readings(START - dt.timedelta(days=1), minutes=10))
    info = table.info()
    assert (info["rows"], info["files"]) == (350, 2)


def test_info_of_plain_table_has_no_contract(lake: timelake.Lake) -> None:
    info = lake.create_table("iot.devices", SCHEMA).info()
    assert (info["time_column"], info["chunk"]) == (None, None)


def test_info_has_documented_keys(table: timelake.Table) -> None:
    assert set(table.info()) == {
        "name",
        "version",
        "location",
        "time_column",
        "series_key",
        "chunk",
        "dedup",
        "rows",
        "files",
        "bytes",
        "snapshots",
        "manifests",
        "last_value_index",
    }


@pytest.mark.network  # DuckDB downloads its iceberg extension on first use
def test_duckdb_reads_the_table(table: timelake.Table) -> None:
    table.append(readings())
    con = duckdb.connect()
    con.execute("INSTALL iceberg; LOAD iceberg")
    assert con.sql(f"SELECT count(*) FROM iceberg_scan('{table.location}')").fetchone() == (300,)  # noqa: S608 (the test's own table location)


def test_rows_sent_twice_count_once_unless_a_session_turns_dedup_off(
    lake: timelake.Lake, table: timelake.Table
) -> None:
    newer = readings(value=2.0)
    table.append(readings(), maintain=False)
    table.append(newer, maintain=False)
    latest = sum(newer.column("value").to_pylist())
    assert lake.sql("SELECT count(*) AS n, sum(value) AS s FROM iot.readings").to_pylist() == [{"n": 300, "s": latest}]
    lake.sql("SET timelake.read_dedup = false")
    assert lake.sql("SELECT count(*) AS n FROM iot.readings").to_pylist() == [{"n": 600}]
