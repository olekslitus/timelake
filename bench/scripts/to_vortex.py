"""Convert benchmark datasets to Vortex (and a sorted TSBS layout in both formats) with DuckDB.

Writes, and reports size + write time for each:
  data/tpch/vortex/<t>.vortex               same row order as the Parquet files
  data/clickbench/vortex/hits_<i>.vortex    same row order as the Parquet files
  data/tsbs/vortex/<t>.vortex               same row order as data/tsbs/parquet (time order)
  data/tsbs/parquet-sorted/<t>.parquet      sorted by (tags_id, time): the layout Timelake writes
  data/tsbs/vortex-sorted/<t>.vortex        sorted by (tags_id, time)

Results are appended to results/formats.jsonl.
"""

import json
import time
from pathlib import Path

import duckdb

DATA = Path(__file__).resolve().parent.parent / "data"
RESULTS = Path(__file__).resolve().parent.parent / "results"


def copy(con, src_sql: str, dst: Path, fmt: str, rec: dict):
    dst.parent.mkdir(parents=True, exist_ok=True)
    opts = "FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 1000000" if fmt == "parquet" else "FORMAT vortex"
    t = time.perf_counter()
    con.execute(f"COPY ({src_sql}) TO '{dst}' ({opts})")
    rec.update(write_s=round(time.perf_counter() - t, 3), bytes=dst.stat().st_size)
    with (RESULTS / "formats.jsonl").open("a") as f:
        f.write(json.dumps(rec) + "\n")
    print(
        f"{rec['dataset']:12} {rec['table']:14} {fmt:8} {rec['layout']:7} {rec['bytes'] / 1e6:9.1f} MB  write {rec['write_s']:6.2f}s"
    )


def main():
    con = duckdb.connect()
    con.execute("INSTALL vortex; LOAD vortex; SET TimeZone = 'UTC'")
    (RESULTS / "formats.jsonl").unlink(missing_ok=True)

    for t in ["lineitem", "orders", "customer", "part", "partsupp", "supplier", "nation", "region"]:
        src = DATA / "tpch" / f"{t}.parquet"
        base = {"dataset": "tpch", "table": t, "layout": "as-is"}
        with (RESULTS / "formats.jsonl").open("a") as f:
            f.write(json.dumps({**base, "format": "parquet", "bytes": src.stat().st_size}) + "\n")
        copy(
            con,
            f"SELECT * FROM '{src}'",
            DATA / "tpch" / "vortex" / f"{t}.vortex",
            "vortex",
            {**base, "format": "vortex"},
        )

    for i in range(10):
        src = DATA / "clickbench" / f"hits_{i}.parquet"
        base = {"dataset": "clickbench", "table": f"hits_{i}", "layout": "as-is"}
        with (RESULTS / "formats.jsonl").open("a") as f:
            f.write(json.dumps({**base, "format": "parquet", "bytes": src.stat().st_size}) + "\n")
        # Read with binary_as_string so string columns are stored as strings in Vortex too.
        copy(
            con,
            f"SELECT * FROM read_parquet('{src}', binary_as_string=True)",
            DATA / "clickbench" / "vortex" / f"hits_{i}.vortex",
            "vortex",
            {**base, "format": "vortex"},
        )

    for t in ["tags", "readings", "diagnostics"]:
        src = DATA / "tsbs" / "parquet" / f"{t}.parquet"
        base = {"dataset": "tsbs", "table": t}
        with (RESULTS / "formats.jsonl").open("a") as f:
            f.write(json.dumps({**base, "layout": "as-is", "format": "parquet", "bytes": src.stat().st_size}) + "\n")
        copy(
            con,
            f"SELECT * FROM '{src}'",
            DATA / "tsbs" / "vortex" / f"{t}.vortex",
            "vortex",
            {**base, "layout": "as-is", "format": "vortex"},
        )
        order = "ORDER BY id" if t == "tags" else "ORDER BY tags_id, time"
        copy(
            con,
            f"SELECT * FROM '{src}' {order}",
            DATA / "tsbs" / "parquet-sorted" / f"{t}.parquet",
            "parquet",
            {**base, "layout": "sorted", "format": "parquet"},
        )
        copy(
            con,
            f"SELECT * FROM '{src}' {order}",
            DATA / "tsbs" / "vortex-sorted" / f"{t}.vortex",
            "vortex",
            {**base, "layout": "sorted", "format": "vortex"},
        )


if __name__ == "__main__":
    main()
