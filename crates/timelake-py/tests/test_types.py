"""Typed use of the API: `ty check` verifies these annotations against the stub; pytest runs them."""

from __future__ import annotations

from typing import TYPE_CHECKING

from conftest import readings

if TYPE_CHECKING:
    import pyarrow as pa

    import timelake


def test_results_are_typed(table: timelake.Table) -> None:
    result: timelake.AppendResult = table.append(readings(), batch_id="b1")
    rows: int = result["rows"]
    duplicate: bool = result["duplicate"]
    maintenance: timelake.MaintainReport | None = result.get("maintenance")
    report: timelake.MaintainReport = table.maintain()
    seconds: float = report["seconds"]
    info: timelake.TableInfo = table.info()
    chunk: str | None = info["chunk"]
    series_key: list[str] = info["series_key"]
    assert (rows, duplicate, maintenance, seconds >= 0, chunk, series_key) == (
        300,
        False,
        None,
        True,
        "day",
        ["device"],
    )


def test_queries_return_pyarrow_tables(lake: timelake.Lake, table: timelake.Table) -> None:
    table.append(readings())
    result: pa.Table = lake.sql("SELECT count(*) AS n FROM iot.readings")
    latest: pa.Table = lake.latest(table.name)
    names: list[str] = lake.tables()
    assert (result.num_rows, latest.num_rows, names) == (1, 5, ["iot.readings"])


def test_protocols_describe_arrow_inputs() -> None:
    data = readings()
    stream: timelake.ArrowStreamExportable = data
    schema: timelake.ArrowSchemaExportable = data.schema
    with_schema: timelake.HasArrowSchema = data
    assert (stream, schema, with_schema) == (data, data.schema, data)
