"""Convert benchmark datasets to Vortex (and a sorted TSBS layout in both formats) with DuckDB.

Writes, and reports size + write time for each:
  data/tpch/vortex/<t>.vortex               same row order as the Parquet files
  data/clickbench/vortex/hits_<i>.vortex    same row order as the Parquet files
  data/tsbs/vortex/<t>.vortex               same row order as data/tsbs/parquet (time order)
  data/tsbs/parquet-sorted/<t>.parquet      sorted by (tags_id, time): the layout Timelake writes
  data/tsbs/vortex-sorted/<t>.vortex        sorted by (tags_id, time)

Results are appended to results/formats.jsonl (replaced on each run).
"""

from __future__ import annotations

import argparse
import time
from typing import TYPE_CHECKING, TypedDict

import duckdb

from timebench import DATA, RESULTS, TPCH_TABLES, TSBS_TABLES
from timebench.results import append_jsonl

if TYPE_CHECKING:
    from pathlib import Path

FORMATS = RESULTS / "formats.jsonl"


class FormatRecord(TypedDict, total=False):
    """One file of one dataset in one format and layout."""

    dataset: str
    table: str
    layout: str
    """``as-is`` (the source's row order) or ``sorted``."""
    format: str
    bytes: int
    write_s: float


def record_source(src: Path, rec: FormatRecord) -> None:
    """Records the size of an existing Parquet file."""
    append_jsonl(FORMATS, {**rec, "format": "parquet", "bytes": src.stat().st_size})


def copy(con: duckdb.DuckDBPyConnection, src_sql: str, dst: Path, rec: FormatRecord) -> None:
    """Writes a query result to ``dst`` in ``rec["format"]`` and records its size and write time."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    fmt = rec["format"]
    opts = "FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 1000000" if fmt == "parquet" else "FORMAT vortex"
    start = time.perf_counter()
    con.execute(f"COPY ({src_sql}) TO '{dst}' ({opts})")
    rec.update(write_s=round(time.perf_counter() - start, 3), bytes=dst.stat().st_size)
    append_jsonl(FORMATS, rec)
    print(
        f"{rec['dataset']:12} {rec['table']:14} {fmt:8} {rec['layout']:7} {rec['bytes'] / 1e6:9.1f} MB  "
        f"write {rec['write_s']:6.2f}s"
    )


def convert_tpch(con: duckdb.DuckDBPyConnection) -> None:
    """TPC-H tables to Vortex, same row order."""
    for t in TPCH_TABLES:
        src = DATA / "tpch" / f"{t}.parquet"
        base: FormatRecord = {"dataset": "tpch", "table": t, "layout": "as-is"}
        record_source(src, base)
        copy(con, f"SELECT * FROM '{src}'", DATA / "tpch" / "vortex" / f"{t}.vortex", {**base, "format": "vortex"})


def convert_clickbench(con: duckdb.DuckDBPyConnection) -> None:
    """ClickBench partitions to Vortex, same row order."""
    for i in range(10):
        src = DATA / "clickbench" / f"hits_{i}.parquet"
        base: FormatRecord = {"dataset": "clickbench", "table": f"hits_{i}", "layout": "as-is"}
        record_source(src, base)
        # Read with binary_as_string so string columns are stored as strings in Vortex too.
        copy(
            con,
            f"SELECT * FROM read_parquet('{src}', binary_as_string=True)",
            DATA / "clickbench" / "vortex" / f"hits_{i}.vortex",
            {**base, "format": "vortex"},
        )


def convert_tsbs(con: duckdb.DuckDBPyConnection) -> None:
    """TSBS tables to Vortex, and sorted by (tags_id, time) in both formats."""
    tsbs = DATA / "tsbs"
    for t in TSBS_TABLES:
        src = tsbs / "parquet" / f"{t}.parquet"
        record_source(src, {"dataset": "tsbs", "table": t, "layout": "as-is"})
        as_is: FormatRecord = {"dataset": "tsbs", "table": t, "layout": "as-is", "format": "vortex"}
        copy(con, f"SELECT * FROM '{src}'", tsbs / "vortex" / f"{t}.vortex", as_is)
        order = "ORDER BY id" if t == "tags" else "ORDER BY tags_id, time"
        for fmt in ("parquet", "vortex"):
            sorted_rec: FormatRecord = {"dataset": "tsbs", "table": t, "layout": "sorted", "format": fmt}
            copy(con, f"SELECT * FROM '{src}' {order}", tsbs / f"{fmt}-sorted" / f"{t}.{fmt}", sorted_rec)


def main() -> None:
    """Converts every dataset and rewrites results/formats.jsonl."""
    con = duckdb.connect()
    con.execute("INSTALL vortex; LOAD vortex; SET TimeZone = 'UTC'")
    FORMATS.unlink(missing_ok=True)
    convert_tpch(con)
    convert_clickbench(con)
    convert_tsbs(con)


if __name__ == "__main__":
    argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter).parse_args()
    main()
