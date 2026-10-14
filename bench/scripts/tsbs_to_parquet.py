"""Convert TSBS IoT output (--format=timescaledb, read from stdin) into normalized Parquet.

Produces the same schema TSBS loads into TimescaleDB, so the ported queries stay comparable:
  tags(id, name, fleet, driver, model, device_version, load_capacity, fuel_capacity, nominal_fuel_consumption)
  readings(time, tags_id, latitude, longitude, elevation, velocity, heading, grade, fuel_consumption)
  diagnostics(time, tags_id, fuel_state, current_load, status)

Usage: tsbs_generate_data ... --format=timescaledb | python tsbs_to_parquet.py <out_dir>
"""

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
    def __init__(self, path: Path, value_cols: list[str]):
        self.value_cols = value_cols
        self.schema = pa.schema(
            [("time", pa.timestamp("us", tz="UTC")), ("tags_id", pa.int32())] + [(c, pa.float64()) for c in value_cols]
        )
        self.writer = pq.ParquetWriter(path, self.schema, compression="zstd")
        self.reset()
        self.rows = 0

    def reset(self):
        self.time, self.tags_id = [], []
        self.values = [[] for _ in self.value_cols]

    def add(self, tags_id: int, fields: list[str]):
        self.time.append(int(fields[0]) // 1000)
        self.tags_id.append(tags_id)
        for col, raw in zip(self.values, fields[1:]):
            col.append(float(raw) if raw else None)
        if len(self.time) >= BATCH:
            self.flush()

    def flush(self):
        if not self.time:
            return
        arrays = [pa.array(self.time, pa.timestamp("us", tz="UTC")), pa.array(self.tags_id, pa.int32())]
        arrays += [pa.array(v, pa.float64()) for v in self.values]
        self.writer.write_table(pa.Table.from_arrays(arrays, schema=self.schema), row_group_size=BATCH)
        self.rows += len(self.time)
        self.reset()

    def close(self):
        self.flush()
        self.writer.close()


def parse_tags(line: str) -> dict[str, str | None]:
    out: dict[str, str | None] = {}
    for kv in line.split(",")[1:]:
        k, _, v = kv.partition("=")
        out[k] = v or None
    return out


def main(out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    readings = TableWriter(out_dir / "readings.parquet", READING_COLS)
    diagnostics = TableWriter(out_dir / "diagnostics.parquet", DIAG_COLS)
    tag_ids: dict[str, int] = {}
    tag_rows: list[dict] = []
    current = 0

    for line in sys.stdin:
        line = line.rstrip("\n")
        if not line:
            continue
        kind, _, rest = line.partition(",")
        if kind == "tags":
            if "=" not in rest:  # header line
                continue
            current = tag_ids.get(rest)
            if current is None:
                current = len(tag_ids) + 1
                tag_ids[rest] = current
                tag_rows.append({"id": current, **parse_tags(line)})
        elif kind == "readings":
            if rest[0].isdigit():
                readings.add(current, rest.split(","))
        elif kind == "diagnostics":
            if rest[0].isdigit():
                diagnostics.add(current, rest.split(","))

    readings.close()
    diagnostics.close()
    tags = pa.table(
        {
            "id": pa.array([r["id"] for r in tag_rows], pa.int32()),
            **{c: pa.array([r.get(c) for r in tag_rows], pa.string()) for c in TAG_COLS},
            **{c: pa.array([float(r[c]) if r.get(c) else None for r in tag_rows], pa.float64()) for c in TAG_FLOATS},
        }
    )
    pq.write_table(tags, out_dir / "tags.parquet", compression="zstd")
    print(f"tags={len(tag_rows)} readings={readings.rows} diagnostics={diagnostics.rows}", file=sys.stderr)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
