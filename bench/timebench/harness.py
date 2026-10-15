"""One benchmark run: a workload streamed into each system, then its queries on every reader, at each checkpoint.

The checkpoints are right after ingest and after each system's maintenance. The run writes
``results/runs/<run id>.jsonl`` as it goes.
"""

from __future__ import annotations

import datetime as dt
import json
import statistics
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import numpy as np

from timebench import RUNS, meta
from timebench.queries import apply_dialect
from timebench.results import EndRecord, IngestRecord, QueryRecord, RunRecord, append_jsonl, best_time, first_time
from timebench.s3 import PROXY, ProxyStats
from timebench.systems import DIALECTS, System, systems
from timebench.targets import Place
from timebench.worker import request_kinds

if TYPE_CHECKING:
    from pathlib import Path

    from timebench.targets import Target
    from timebench.workloads import Query, Workload

CHECKPOINTS = ("ingested", "maintained")


@dataclass
class RunSpec:
    """What one run covers."""

    workload: Workload
    target: Target
    systems: list[str]
    readers: list[str] | None = None
    """Only these readers (all of each system's by default)."""
    checkpoints: tuple[str, ...] = CHECKPOINTS
    queries: set[str] | None = None
    """Only these queries (by name)."""
    runs: int = 2
    """Repeat runs per query after the first run."""
    timeout: int = 600
    """Seconds per query process (all its runs)."""
    ttfb_ms: int | None = None
    """Latency the proxy adds per request (local object stores)."""
    label: str = ""
    reuse: bool = False
    """Query the tables an earlier run left instead of ingesting (``--checkpoints`` then picks the passes)."""
    _systems: dict[str, System] = field(default_factory=dict)

    def system(self, name: str) -> System:
        """The adapter of one system, created on first use."""
        if name not in self._systems:
            cls = systems()[name]
            place = Place(self.target, self.workload.dataset, name)
            self._systems[name] = cls(place, self.workload.namespace)
        return self._systems[name]

    def readers_of(self, name: str) -> list[str]:
        """The readers of a system in this run."""
        return [r for r in systems()[name].readers if self.readers is None or r in self.readers]


def run(spec: RunSpec) -> Path:
    """Runs everything and returns the run file."""
    workload, target = spec.workload, spec.target
    workload.prepare()
    if target.s3 and spec.ttfb_ms is not None:
        set_ttfb(spec.ttfb_ms)
    started = dt.datetime.now(dt.timezone.utc)
    run_id = f"{started:%Y%m%dT%H%M%SZ}-{workload.dataset}-{target.name}"
    path = RUNS / f"{run_id}.jsonl"
    versions: dict[str, str] = {}
    for name in spec.systems:
        versions.update(systems()[name].version())
    header: RunRecord = {
        "kind": "run",
        "id": run_id,
        "workload": workload.name,
        "scale": workload.scale,
        "params": workload.params(),
        "target": target.name,
        "storage": target.storage,
        "machine": meta.machine(),
        "commit": meta.commit(),
        "dirty": meta.dirty(),
        "label": spec.label,
        "started": started.isoformat(timespec="seconds"),
        "readers": {s: spec.readers_of(s) for s in spec.systems},
        "versions": versions,
        "runs": spec.runs,
    }
    if target.s3 and spec.ttfb_ms is not None:
        header["ttfb_ms"] = spec.ttfb_ms
    append_jsonl(path, header)
    print(f"run {run_id} → {path}", flush=True)

    live = list(spec.systems)
    if not spec.reuse:
        live = [s for s in live if record(path, ingest(spec, spec.system(s)))]
    results: list[QueryRecord] = []
    for checkpoint in spec.checkpoints:
        if checkpoint == "maintained" and not spec.reuse:
            live = [s for s in live if record(path, maintain(spec.system(s)))]
        for s in live:
            for reader in spec.readers_of(s):
                for query in workload.queries():
                    if spec.queries and query.name not in spec.queries:
                        continue
                    r = measure(spec, spec.system(s), reader, query, checkpoint)
                    append_jsonl(path, r)
                    results.append(r)
                    print(summary_line(r), flush=True)

    end: EndRecord = {
        "kind": "end",
        "finished": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "seconds": round((dt.datetime.now(dt.timezone.utc) - started).total_seconds(), 1),
        "mismatches": mismatches(results),
    }
    append_jsonl(path, end)
    for m in end["mismatches"]:
        print(f"ROW COUNT MISMATCH {m}", flush=True)
    return path


def record(path: Path, r: IngestRecord) -> bool:
    """Appends an ingest or maintenance record; whether the system is still in the run."""
    append_jsonl(path, r)
    shown = {k: v for k, v in r.items() if k not in ("kind", "kinds")}
    print(f"{r['kind']:8} {shown}", flush=True)
    return r["status"] == "ok"


def counted(system: System) -> bool:
    """Whether the system's S3 traffic goes through the counting proxy."""
    return system.target.s3 and not system.server


def ingest(spec: RunSpec, system: System) -> IngestRecord:
    """Creates the tables, loads the initial rows, then commits every arrival of the stream."""
    out: IngestRecord = {"kind": "ingest", "system": system.name}
    before = PROXY.stats() if counted(system) else None
    latencies: list[float] = []
    rows = 0
    start = time.perf_counter()
    try:
        system.reset()
        workload = spec.workload
        for t in workload.tables:
            system.create(t, workload.schema(t.name))
        for table, data in workload.initial():
            system.append(table, data)
        for i, arrival in enumerate(workload.stream()):
            for table, data in arrival:
                t = time.perf_counter()
                system.append(table, data)
                latencies.append(time.perf_counter() - t)
                rows += data.num_rows
            if i % 100 == 0:
                print(f"  {system.name}: arrival {i}, {time.perf_counter() - start:.1f}s", flush=True)
        seconds = time.perf_counter() - start
        state = {**system.state(), "phase": "ingested", "ingested_at": now()}
        system.place.save_state(state)
        out.update(
            status="ok",
            commits=len(latencies),
            rows=rows,
            seconds=round(seconds, 2),
            commit_ms_p50=round(statistics.median(latencies) * 1000, 1),
            commit_ms_p95=round(float(np.percentile(latencies, 95)) * 1000, 1),
            commit_ms_max=round(max(latencies) * 1000, 1),
        )
        out.update(storage(system))
        out.update(system.ingest_extras())
    except Exception as e:  # noqa: BLE001 (a failing system is a result; the run goes on without it)
        out.update(status="error", error=f"{type(e).__name__}: {e}"[:300], commits=len(latencies))
    return {**out, **proxy_delta(before)}


def maintain(system: System) -> IngestRecord:
    """Runs the system's maintenance on what ingest left."""
    out: IngestRecord = {"kind": "maintain", "system": system.name}
    before = PROXY.stats() if counted(system) else None
    start = time.perf_counter()
    try:
        system.maintain()
        seconds = time.perf_counter() - start
        state = {**system.place.load_state(), **system.state(), "phase": "maintained"}
        system.place.save_state(state)
        out.update(status="ok", seconds=round(seconds, 2))
        out.update(storage(system))
        out.update(system.maintain_extras())
    except Exception as e:  # noqa: BLE001 (as in ingest)
        out.update(status="error", error=f"{type(e).__name__}: {e}"[:300])
    return {**out, **proxy_delta(before)}


def storage(system: System) -> IngestRecord:
    """The objects and bytes the system's tables take now."""
    stats = system.stats()
    return {
        "objects": stats["objects"],
        "bytes": stats["bytes"],
        "data_files": stats["data_files"],
        "data_bytes": stats["data_bytes"],
    }


def proxy_delta(before: ProxyStats | None) -> IngestRecord:
    """S3 requests since ``before`` (nothing if the traffic isn't counted)."""
    if before is None:
        return {}
    after = PROXY.stats()
    out: IngestRecord = {"requests": after["requests"] - before["requests"]}
    if kinds := request_kinds(before, after):
        out["kinds"] = kinds
    return out


def measure(spec: RunSpec, system: System, reader: str, query: Query, checkpoint: str) -> QueryRecord:
    """Runs one query in a fresh process: its record, with ``status`` ok, error or timeout."""
    out: QueryRecord = {
        "kind": "query",
        "system": system.name,
        "reader": reader,
        "checkpoint": checkpoint,
        "suite": query.suite,
        "query": query.name,
    }
    sql = apply_dialect(query.sql, DIALECTS[reader])
    place = system.place
    if reader in system.commands:
        cmd = type(system).reader_command(reader, place, place.load_state(), spec.runs)
    else:
        job = {"system": system.name, "reader": reader, "target": place.target.name, "dataset": place.dataset}
        cmd = [sys.executable, "-m", "timebench.worker", json.dumps({**job, "runs": spec.runs})]
    before = PROXY.stats() if counted(system) else None
    try:
        # A failing query is a result to record, not a reason to stop: no check=True.
        proc = subprocess.run(cmd, input=sql, capture_output=True, text=True, timeout=spec.timeout, check=False)
    except subprocess.TimeoutExpired:
        return {**out, "status": "timeout"}
    if proc.returncode != 0:
        lines = proc.stderr.strip().splitlines() or ["?"]
        error = next((line for line in reversed(lines) if "Error" in line or "Exception" in line), lines[-1])
        return {**out, "status": "error", "error": error[:300]}
    measured: QueryRecord = json.loads(proc.stdout.strip().splitlines()[-1])
    out.update(measured, status="ok")
    # Requests by kind over all runs, for readers that don't report them per run (the Timelake CLI).
    if before and "kinds" not in out and (total := request_kinds(before, PROXY.stats())):
        out["kinds_total"] = total
    return out


def mismatches(results: list[QueryRecord]) -> list[str]:
    """Queries whose row counts differ between readers at the same checkpoint."""
    rows: dict[tuple[str, str], dict[str, int | None]] = {}
    for r in results:
        if r["status"] == "ok":
            rows.setdefault((r["checkpoint"], r["query"]), {})[f"{r['system']}+{r['reader']}"] = r["rows"]
    return [
        f"{checkpoint}/{query}: " + ", ".join(f"{k}={v}" for k, v in counts.items())
        for (checkpoint, query), counts in rows.items()
        if len(set(counts.values())) > 1
    ]


def summary_line(r: QueryRecord) -> str:
    """One line per query for the console."""
    prefix = f"{r['system']}+{r['reader']:11} {r['checkpoint']:10} {r['query']:36}"
    if r["status"] != "ok":
        return f"{prefix} {r['status'].upper()}: {r.get('error', '')[:120]}"
    reqs = f"  reqs {r['requests'][0]}/{min(r['requests'])}" if "requests" in r else ""
    return f"{prefix} first {first_time(r):8.3f}s  best {best_time(r):8.3f}s  rows {r['rows']}{reqs}"


def set_ttfb(ms: int) -> None:
    """Sets the latency the counting proxy adds per request."""
    with urllib.request.urlopen(f"http://{PROXY.admin}/ttfb?ms={ms}", data=b"", timeout=5):  # a POST
        pass


def now() -> str:
    """The current UTC time, ISO 8601."""
    return dt.datetime.now(dt.timezone.utc).isoformat()
