"""TSBS IoT (SPEC §17.1): a truck fleet's readings and diagnostics, streamed in Firehose-style time windows."""

from __future__ import annotations

import itertools
import shutil
import subprocess
import sys
from typing import TYPE_CHECKING, ClassVar, override

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from benchlib import BENCH
from benchlib.workloads import Batch, TableSpec, Workload

if TYPE_CHECKING:
    from collections.abc import Iterator

TRUCKS = {"small": 50, "standard": 500, "large": 5000}
"""TSBS ``--scale`` of each scale. 500 trucks make 11.7M readings and 11.7M diagnostics over the 3 days."""
SEED = 123
START, END = "2026-01-01T00:00:00Z", "2026-01-04T00:00:00Z"
"""Every scale covers the same 3 days, so the queries' fixed time windows (near the end) hold everywhere."""
GENERATOR = BENCH / ".bin" / "tsbs_generate_data"


def windows(table: pa.Table, minutes: int) -> list[pa.Table]:
    """Splits a table by time window, in time order; rows within a window keep their order."""
    us = pc.cast(table["time"], pa.int64()).to_numpy()
    w = us // (minutes * 60_000_000)
    order = np.argsort(w, kind="stable")
    table, w = table.take(order), w[order]
    cuts = np.flatnonzero(np.diff(w)) + 1
    bounds = [0, *cuts.tolist(), len(w)]
    return [table.slice(a, b - a) for a, b in itertools.pairwise(bounds)]


class TsbsIot(Workload):
    """TSBS IoT, appended in time windows (5 minutes by default: Firehose's default buffer interval)."""

    name = "tsbs-iot"
    title = "TSBS IoT"
    scales: ClassVar[dict[str, str]] = {
        "small": "50 trucks, 3 days at 10 s (1.2M readings + 1.2M diagnostics)",
        "standard": "500 trucks, 3 days at 10 s (11.7M readings + 11.7M diagnostics)",
        "large": "5,000 trucks, 3 days at 10 s (117M readings + 117M diagnostics)",
    }
    default_scale = "standard"
    namespace = "tsbs"
    tables = (
        TableSpec("tags"),
        TableSpec("readings", "time", ("tags_id",)),
        TableSpec("diagnostics", "time", ("tags_id",)),
    )
    suites = ("tsbs_iot", "iot_point")

    def __init__(self, scale: str | None = None, *, window_minutes: int = 5, max_windows: int = 0) -> None:
        super().__init__(scale)
        self.window_minutes = window_minutes
        self.max_windows = max_windows

    @override
    def params(self) -> dict[str, object]:
        params: dict[str, object] = {"window_minutes": self.window_minutes, "seed": SEED}
        if self.max_windows:
            params["max_windows"] = self.max_windows
        return params

    def path(self, table: str) -> str:
        """A table's Parquet file."""
        return str(self.data_dir / f"{table}.parquet")

    @override
    def prepare(self) -> None:
        if all((self.data_dir / f"{t.name}.parquet").exists() for t in self.tables):
            return
        if not GENERATOR.exists():
            msg = f"{GENERATOR} is missing: see bench/README.md, Setup"
            raise SystemExit(msg)
        tmp = self.data_dir.with_name(self.data_dir.name + ".tmp")
        shutil.rmtree(tmp, ignore_errors=True)
        generate = [
            str(GENERATOR),
            "--use-case=iot",
            f"--seed={SEED}",
            f"--scale={TRUCKS[self.scale]}",
            f"--timestamp-start={START}",
            f"--timestamp-end={END}",
            "--log-interval=10s",
            "--format=timescaledb",
        ]
        convert = [sys.executable, str(BENCH / "scripts" / "tsbs_to_parquet.py"), str(tmp)]
        print(f"generating {self.dataset} into {self.data_dir}", flush=True)
        with subprocess.Popen(generate, stdout=subprocess.PIPE) as gen:
            subprocess.run(convert, stdin=gen.stdout, check=True)
        if gen.returncode:
            msg = f"tsbs_generate_data failed with exit code {gen.returncode}"
            raise RuntimeError(msg)
        tmp.rename(self.data_dir)

    @override
    def schema(self, table: str) -> pa.Schema:
        return pq.read_schema(self.path(table))

    @override
    def initial(self) -> Iterator[Batch]:
        yield "tags", pq.read_table(self.path("tags"))

    @override
    def stream(self) -> Iterator[list[Batch]]:
        readings, diagnostics = (
            windows(pq.read_table(self.path(t)), self.window_minutes) for t in ("readings", "diagnostics")
        )
        pairs = zip(readings, diagnostics, strict=False)
        if self.max_windows:
            pairs = itertools.islice(pairs, self.max_windows)
        for r, d in pairs:
            yield [("readings", r), ("diagnostics", d)]
