"""Copy the first N trucks of the TSBS IoT Parquet tables (for the demo warehouse).

uv run python scripts/slice_tsbs.py bench/data/tsbs/parquet bench/data/demo-src 50
"""

from __future__ import annotations

import argparse
from pathlib import Path

import duckdb


def main(src: Path, dst: Path, trucks: int) -> None:
    """Writes ``tags``, ``readings`` and ``diagnostics`` with tag ids up to ``trucks``."""
    dst.mkdir(parents=True, exist_ok=True)
    # Paths and the truck count come from the command line of a local build script.
    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")
    con.execute(f"COPY (SELECT * FROM '{src}/tags.parquet' WHERE id <= {trucks}) TO '{dst}/tags.parquet'")  # noqa: S608
    for t in ("readings", "diagnostics"):
        con.execute(f"COPY (SELECT * FROM '{src}/{t}.parquet' WHERE tags_id <= {trucks}) TO '{dst}/{t}.parquet'")  # noqa: S608


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("src", type=Path, help="directory with the full TSBS tables")
    p.add_argument("dst", type=Path, help="output directory")
    p.add_argument("trucks", type=int, help="keep tag ids 1..trucks")
    args = p.parse_args()
    main(args.src, args.dst, args.trucks)
