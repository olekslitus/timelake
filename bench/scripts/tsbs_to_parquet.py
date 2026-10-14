"""Convert TSBS IoT output (--format=timescaledb, read from stdin) into normalized Parquet.

Produces the same schema TSBS loads into TimescaleDB, so the ported queries stay comparable:
  tags(id, name, fleet, driver, model, device_version, load_capacity, fuel_capacity, nominal_fuel_consumption)
  readings(time, tags_id, latitude, longitude, elevation, velocity, heading, grade, fuel_consumption)
  diagnostics(time, tags_id, fuel_state, current_load, status)

Usage: tsbs_generate_data ... --format=timescaledb | python tsbs_to_parquet.py <out_dir>
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

TAG_COLS = ["name", "fleet", "driver", "model", "device_version"]
TAG_FLOATS = ["load_capacity", "fuel_capacity", "nominal_fuel_consumption"]
READING_COLS = ["latitude", "longitude", "elevation", "velocity", "heading", "grade", "fuel_consumption"]
DIAG_COLS = ["fuel_state", "current_load", "status"]
BATCH = 1_000_000


class TableWriter:
    """Buffers rows of one measurement table and writes them as Parquet row groups of ``BATCH`` rows."""

    def __init__(self, path: Path, value_cols: list[str]) -> None:
        self.value_cols = value_cols
        self.schema = pa.schema(
            [("time", pa.timestamp("us", tz="UTC")), ("tags_id", pa.int32())] + [(c, pa.float64()) for c in value_cols]
        )
        self.writer = pq.ParquetWriter(path, self.schema, compression="zstd")
        self.rows = 0
        self.reset()

    def reset(self) -> None:
        """Empties the buffer."""
        self.time: list[int] = []
        self.tags_id: list[int] = []
        self.values: list[list[float | None]] = [[] for _ in self.value_cols]

    def add(self, tags_id: int, fields: list[str]) -> None:
        """Adds one row: TSBS's nanosecond timestamp, then the values (empty = null)."""
        self.time.append(int(fields[0]) // 1000)
        self.tags_id.append(tags_id)
        for col, raw in zip(self.values, fields[1:], strict=True):
            col.append(float(raw) if raw else None)
        if len(self.time) >= BATCH:
            self.flush()

    def flush(self) -> None:
        """Writes the buffered rows as one row group."""
        if not self.time:
            return
        arrays = [pa.array(self.time, pa.timestamp("us", tz="UTC")), pa.array(self.tags_id, pa.int32())]
        arrays += [pa.array(v, pa.float64()) for v in self.values]
        self.writer.write_table(pa.Table.from_arrays(arrays, schema=self.schema), row_group_size=BATCH)
        self.rows += len(self.time)
        self.reset()

    def close(self) -> None:
        """Writes what is left and closes the file."""
        self.flush()
        self.writer.close()


def parse_tags(line: str) -> dict[str, str | None]:
    """``tags,name=truck_1,fleet=South,...`` -> ``{"name": "truck_1", ...}``; empty values are None."""
    out: dict[str, str | None] = {}
    for kv in line.split(",")[1:]:
        k, _, v = kv.partition("=")
        out[k] = v or None
    return out


def tags_table(tag_rows: list[dict[str, str | None]], ids: list[int]) -> pa.Table:
    """The ``tags`` dimension table; ``ids[i]`` is the id of ``tag_rows[i]``."""
    floats = {c: [float(v) if (v := r.get(c)) else None for r in tag_rows] for c in TAG_FLOATS}
    return pa.table(
        {
            "id": pa.array(ids, pa.int32()),
            **{c: pa.array([r.get(c) for r in tag_rows], pa.string()) for c in TAG_COLS},
            **{c: pa.array(v, pa.float64()) for c, v in floats.items()},
        }
    )


def main(out_dir: Path) -> None:
    """Reads TSBS output from stdin and writes the three tables to ``out_dir``."""
    out_dir.mkdir(parents=True, exist_ok=True)
    writers = {
        "readings": TableWriter(out_dir / "readings.parquet", READING_COLS),
        "diagnostics": TableWriter(out_dir / "diagnostics.parquet", DIAG_COLS),
    }
    tag_ids: dict[str, int] = {}
    tag_rows: list[dict[str, str | None]] = []
    current = 0

    for raw_line in sys.stdin:
        line = raw_line.rstrip("\n")
        if not line:
            continue
        kind, _, rest = line.partition(",")
        if kind == "tags":
            if "=" not in rest:  # header line
                continue
            if rest not in tag_ids:
                tag_ids[rest] = len(tag_ids) + 1
                tag_rows.append(parse_tags(line))
            current = tag_ids[rest]
        elif kind in writers and rest[0].isdigit():  # rows start with the timestamp; header lines don't
            writers[kind].add(current, rest.split(","))

    for writer in writers.values():
        writer.close()
    pq.write_table(tags_table(tag_rows, list(tag_ids.values())), out_dir / "tags.parquet", compression="zstd")
    counts = " ".join(f"{k}={w.rows}" for k, w in writers.items())
    print(f"tags={len(tag_rows)} {counts}", file=sys.stderr)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("out_dir", type=Path)
    main(p.parse_args().out_dir)
