"""Generate TPC-H with DuckDB's dbgen and write each table as zstd Parquet.

python scripts/tpch_to_parquet.py data/tpch --scale 10 --scratch /mnt/bench/tpch.duckdb
"""

from __future__ import annotations

import argparse
from pathlib import Path

import duckdb

from timebench import TPCH_TABLES


def main(out_dir: Path, scale: float, scratch: Path) -> None:
    """Generates into a scratch database file (SF10 doesn't fit in memory on small machines), then exports."""
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        con = duckdb.connect(str(scratch))
        con.execute(f"INSTALL tpch; LOAD tpch; CALL dbgen(sf={scale})")
        for t in TPCH_TABLES:
            con.execute(f"COPY {t} TO '{out_dir / f'{t}.parquet'}' (FORMAT parquet, COMPRESSION zstd)")
        con.close()
    finally:
        scratch.unlink(missing_ok=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("out_dir", type=Path)
    p.add_argument("--scale", type=float, default=10, help="TPC-H scale factor")
    p.add_argument("--scratch", type=Path, default=Path("tpch.duckdb"), help="temporary DuckDB database file")
    args = p.parse_args()
    main(args.out_dir, args.scale, args.scratch)
