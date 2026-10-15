"""Convert TSBS output (--format=timescaledb, read from stdin) into normalized Parquet.

Produces the schema TSBS loads into TimescaleDB, so the ported queries stay comparable: a ``tags`` table (an ``id``
plus TSBS's tag columns) and one table per measurement (``time``, ``tags_id``, then its fields as doubles). Table
layouts come from TSBS's header lines, so every use case works:
  iot       tags, readings, diagnostics
  cpu-only  tags, cpu

``--tag-column hostname`` also copies that tag into every measurement table, as TSBS's TimescaleDB loader does with
its partition tag (``in-table-partition-tag``), so queries can filter on it without a join.

Usage: tsbs_generate_data ... --format=timescaledb | python tsbs_to_parquet.py <out_dir> [--tag-column NAME]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

BATCH = 1_000_000
FLOAT_TYPES = {"float32", "float64"}


class TableWriter:
    """Buffers rows of one measurement table and writes them as Parquet row groups of ``BATCH`` rows."""

    def __init__(self, path: Path, value_cols: list[str], tag_column: str | None) -> None:
        self.value_cols = value_cols
        self.tag_column = tag_column
        fields = [("time", pa.timestamp("us", tz="UTC")), ("tags_id", pa.int32())]
        fields += [(tag_column, pa.string())] if tag_column else []
        self.schema = pa.schema(fields + [(c, pa.float64()) for c in value_cols])
        self.writer = pq.ParquetWriter(path, self.schema, compression="zstd")
        self.rows = 0
        self.reset()

    def reset(self) -> None:
        """Empties the buffer."""
        self.time: list[int] = []
        self.tags_id: list[int] = []
        self.tag: list[str | None] = []
        self.values: list[list[float | None]] = [[] for _ in self.value_cols]

    def add(self, tags_id: int, tag: str | None, fields: list[str]) -> None:
        """Adds one row: TSBS's nanosecond timestamp, then the values (empty = null)."""
        self.time.append(int(fields[0]) // 1000)
        self.tags_id.append(tags_id)
        self.tag.append(tag)
        for col, raw in zip(self.values, fields[1:], strict=True):
            col.append(float(raw) if raw else None)
        if len(self.time) >= BATCH:
            self.flush()

    def flush(self) -> None:
        """Writes the buffered rows as one row group."""
        if not self.time:
            return
        arrays = [pa.array(self.time, pa.timestamp("us", tz="UTC")), pa.array(self.tags_id, pa.int32())]
        arrays += [pa.array(self.tag, pa.string())] if self.tag_column else []
        arrays += [pa.array(v, pa.float64()) for v in self.values]
        self.writer.write_table(pa.Table.from_arrays(arrays, schema=self.schema), row_group_size=BATCH)
        self.rows += len(self.time)
        self.reset()

    def close(self) -> None:
        """Writes what is left and closes the file."""
        self.flush()
        self.writer.close()


def parse_header(rest: str) -> list[tuple[str, str]]:
    """``name string,load_capacity float32`` -> ``[("name", "string"), ("load_capacity", "float32")]``."""
    return [(name, kind) for name, _, kind in (col.partition(" ") for col in rest.split(","))]


def parse_tags(rest: str) -> dict[str, str | None]:
    """``name=truck_1,fleet=South,...`` -> ``{"name": "truck_1", ...}``; empty values are None."""
    out: dict[str, str | None] = {}
    for kv in rest.split(","):
        k, _, v = kv.partition("=")
        out[k] = v or None
    return out


def tags_table(columns: list[tuple[str, str]], rows: list[dict[str, str | None]], ids: list[int]) -> pa.Table:
    """The ``tags`` table: ``id``, then TSBS's tag columns (float types as doubles, the rest as strings)."""
    data: dict[str, pa.Array] = {"id": pa.array(ids, pa.int32())}
    for name, kind in columns:
        if kind in FLOAT_TYPES:
            data[name] = pa.array([float(v) if (v := r.get(name)) else None for r in rows], pa.float64())
        else:
            data[name] = pa.array([r.get(name) for r in rows], pa.string())
    return pa.table(data)


def main(out_dir: Path, tag_column: str | None) -> None:
    """Reads TSBS output from stdin and writes the tables to ``out_dir``."""
    out_dir.mkdir(parents=True, exist_ok=True)
    writers: dict[str, TableWriter] = {}
    tag_columns: list[tuple[str, str]] = []
    tag_ids: dict[str, int] = {}
    tag_rows: list[dict[str, str | None]] = []
    current, current_tag = 0, None

    for raw_line in sys.stdin:
        line = raw_line.rstrip("\n")
        if not line:
            continue
        kind, _, rest = line.partition(",")
        if kind == "tags":
            if "=" not in rest:  # header: the tag columns and their types
                tag_columns = parse_header(rest)
                continue
            if rest not in tag_ids:
                tag_ids[rest] = len(tag_ids) + 1
                tag_rows.append(parse_tags(rest))
            current = tag_ids[rest]
            current_tag = tag_rows[current - 1].get(tag_column) if tag_column else None
        elif rest[:1].isdigit():  # a row: the timestamp, then the values
            writers[kind].add(current, current_tag, rest.split(","))
        elif kind not in writers:  # header: the measurement's field names
            writers[kind] = TableWriter(out_dir / f"{kind}.parquet", rest.split(","), tag_column)

    for writer in writers.values():
        writer.close()
    pq.write_table(
        tags_table(tag_columns, tag_rows, list(tag_ids.values())), out_dir / "tags.parquet", compression="zstd"
    )
    counts = " ".join(f"{k}={w.rows}" for k, w in writers.items())
    print(f"tags={len(tag_rows)} {counts}", file=sys.stderr)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("out_dir", type=Path)
    p.add_argument("--tag-column", help="copy this tag into every measurement table")
    args = p.parse_args()
    main(args.out_dir, args.tag_column)
