"""One benchmark run: a workload streamed into each system, then its queries on every reader, at each checkpoint.

The checkpoints are right after ingest and after each system's maintenance. Optionally, fresh readers probe each
system while it ingests (``live.py``), and N dashboard clients query it at once after the last checkpoint
(``concurrency.py``). The run writes ``results/runs/<run id>.jsonl`` as it goes.
"""

from __future__ import annotations

import datetime as dt
import json
import statistics
import subprocess
import time
import urllib.request
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import numpy as np

from timebench import RUNS, meta
from timebench.concurrency import dashboards
from timebench.cost import phase_cost, query_cost, storage_month
from timebench.live import Prober
from timebench.queries import apply_dialect
from timebench.results import (
    ConcurrencyRecord,
    EndRecord,
    IngestRecord,
    LiveRecord,
    QueryRecord,
    RunRecord,
    append_jsonl,
    best_time,
    first_time,
)
from timebench.s3 import PROXY, ProxyStats
from timebench.systems import DIALECTS, System, systems
from timebench.targets import Place
from timebench.worker import command, request_kinds

if TYPE_CHECKING:
    from pathlib import Path

    import pyarrow as pa

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
    live_interval: float = 0
    """Seconds between probe rounds while each system ingests; 0 = no probes."""
    concurrency: tuple[int, ...] = ()
    """Client counts for the concurrent-dashboards phase after the last checkpoint; empty = none."""
    concurrency_seconds: float = 30
    """How long each client count runs."""
    pace: float = 0
    """At least this many seconds between arrivals (0 = as fast as the system commits), so the replay is closer to
    real time and probes have something to see."""
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
    spec.workload.prepare()
    if spec.target.s3 and spec.ttfb_ms is not None:
        set_ttfb(spec.ttfb_ms)
    started = dt.datetime.now(dt.timezone.utc)
    header = run_header(spec, started)
    path = RUNS / f"{header['id']}.jsonl"
    append_jsonl(path, header)
    print(f"run {header['id']} → {path}", flush=True)

    live = list(spec.systems) if spec.reuse else ingest_all(spec, path)
    results: list[QueryRecord] = []
    for checkpoint in spec.checkpoints:
        if checkpoint == "maintained" and not spec.reuse:
            live = [s for s in live if record(path, maintain(spec.system(s)))]
        results += query_pass(spec, path, live, checkpoint)
    if spec.concurrency and spec.workload.dashboard_queries() and spec.checkpoints:
        for s in live:
            for clients in spec.concurrency:
                c = dashboards(spec.workload, spec.system(s), spec.checkpoints[-1], clients, spec.concurrency_seconds)
                append_jsonl(path, c)
                print(concurrency_line(c), flush=True)

    finished = dt.datetime.now(dt.timezone.utc)
    end: EndRecord = {
        "kind": "end",
        "finished": finished.isoformat(timespec="seconds"),
        "seconds": round((finished - started).total_seconds(), 1),
        "mismatches": mismatches(results),
    }
    append_jsonl(path, end)
    for m in end["mismatches"]:
        print(f"ROW COUNT MISMATCH {m}", flush=True)
    return path


def run_header(spec: RunSpec, started: dt.datetime) -> RunRecord:
    """The first record of a run: what runs, where, and on which commit."""
    workload, target = spec.workload, spec.target
    versions: dict[str, str] = {}
    for name in spec.systems:
        versions.update(systems()[name].version())
    header: RunRecord = {
        "kind": "run",
        "id": f"{started:%Y%m%dT%H%M%SZ}-{workload.dataset}-{target.name}",
        "workload": workload.name,
        "scale": workload.scale,
        "params": {**workload.params(), "span_days": workload.span_days},
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
    if spec.live_interval:
        header["live_interval_s"] = spec.live_interval
    if spec.pace:
        header["pace_s"] = spec.pace
    if spec.concurrency:
        header.update(concurrency=list(spec.concurrency), concurrency_seconds=spec.concurrency_seconds)
    return header


def ingest_all(spec: RunSpec, path: Path) -> list[str]:
    """Ingests into every system, one at a time; the systems that succeeded."""
    ingested = []
    for s in spec.systems:
        done, probes = ingest(spec, spec.system(s))
        if record(path, done):
            ingested.append(s)
        if probes:
            append_jsonl(path, probes)
            print(live_line(probes), flush=True)
    return ingested


def query_pass(spec: RunSpec, path: Path, systems_: list[str], checkpoint: str) -> list[QueryRecord]:
    """Every query on every reader of the systems, each in a fresh process."""
    results = []
    for s in systems_:
        for reader in spec.readers_of(s):
            for query in spec.workload.queries():
                if spec.queries and query.name not in spec.queries:
                    continue
                r = measure(spec, spec.system(s), reader, query, checkpoint)
                append_jsonl(path, r)
                results.append(r)
                print(summary_line(r), flush=True)
    return results


def record(path: Path, r: IngestRecord) -> bool:
    """Appends an ingest or maintenance record; whether the system is still in the run."""
    append_jsonl(path, r)
    shown = {k: v for k, v in r.items() if k not in ("kind", "kinds")}
    print(f"{r['kind']:8} {shown}", flush=True)
    return r["status"] == "ok"


def counted(system: System) -> bool:
    """Whether the system's S3 traffic goes through the counting proxy."""
    return system.target.s3 and not system.server


def ingest(spec: RunSpec, system: System) -> tuple[IngestRecord, LiveRecord | None]:
    """Creates the tables, loads the initial rows, then commits every arrival of the stream.

    With ``live_interval`` set, fresh readers probe the tables while it runs.
    """
    out: IngestRecord = {"kind": "ingest", "system": system.name}
    workload = spec.workload
    prober = Prober(workload, system, spec.live_interval) if spec.live_interval and workload.live_table else None
    before = PROXY.stats() if counted(system) else None
    latencies: list[float] = []
    rows = 0
    start = time.perf_counter()
    try:
        system.reset()
        for t in workload.tables:
            system.create(t, workload.schema(t.name))
        for table, data in workload.initial():
            system.append(table, data)
        for i, arrival in enumerate(workload.stream()):
            arrived = time.perf_counter()
            for table, data in arrival:
                t = time.perf_counter()
                system.append(table, data)
                latencies.append(time.perf_counter() - t)
                rows += data.num_rows
                if prober and table == workload.live_table:
                    prober.committed(newest_second(data, workload.spec(table).time_column))
            if i == 0 and prober:
                # The tables exist now: readers can find them, so probing can start.
                system.place.save_state({**system.state(), "phase": "ingesting"})
                prober.start()
            if i % 100 == 0:
                print(f"  {system.name}: arrival {i}, {time.perf_counter() - start:.1f}s", flush=True)
            if spec.pace:
                time.sleep(max(0.0, arrived + spec.pace - time.perf_counter()))
        seconds = time.perf_counter() - start
        state = {**system.state(), "phase": "ingested", "ingested_at": now()}
        system.place.save_state(state)
        out.update(
            status="ok",
            commits=len(latencies),
            rows=rows,
            seconds=round(seconds, 2),
            commit_seconds=round(sum(latencies), 2),
            commit_ms_p50=round(statistics.median(latencies) * 1000, 1),
            commit_ms_p95=round(float(np.percentile(latencies, 95)) * 1000, 1),
            commit_ms_max=round(max(latencies) * 1000, 1),
        )
        out.update(storage(system))
        out.update(system.ingest_extras())
    except Exception as e:  # noqa: BLE001 (a failing system is a result; the run goes on without it)
        out.update(status="error", error=f"{type(e).__name__}: {e}"[:300], commits=len(latencies))
    probes = prober.finish() if prober and prober.thread.is_alive() else None
    if probes:
        out["probed"] = True
    return priced({**out, **proxy_delta(before)}, system), probes


def newest_second(data: pa.Table, time_column: str | None) -> int:
    """The newest timestamp in a batch, in whole epoch seconds."""
    if not time_column or data.num_rows == 0:
        return 0
    newest = np.max(data[time_column].to_numpy())  # datetime64, in the column's unit
    return int(newest.astype("datetime64[s]").astype(np.int64))


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
    return priced({**out, **proxy_delta(before)}, system)


def storage(system: System) -> IngestRecord:
    """The objects and bytes the system's tables take now."""
    stats = system.stats()
    return {
        "objects": stats["objects"],
        "bytes": stats["bytes"],
        "data_files": stats["data_files"],
        "data_bytes": stats["data_bytes"],
    }


def priced(r: IngestRecord, system: System) -> IngestRecord:
    """Adds the phase's request cost and the storage's monthly cost at the target's list prices, where priced."""
    target = system.target.name
    if (usd := phase_cost(r, target)) is not None:
        r["usd"] = usd
    if (
        "bytes" in r
        and system.s3_storage_prices
        and not system.server
        and (month := storage_month(r["bytes"], target)) is not None
    ):
        r["storage_usd_month"] = month
    return r


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
        cmd = command({**job, "runs": spec.runs})
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
    if (usd := query_cost(out, spec.target.name)) is not None:
        out["usd"] = usd
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


def live_line(r: LiveRecord) -> str:
    """The probes of one system, for the console."""
    lags = r["lag_s"]
    stale = sum(1 for x in lags if x > 0)
    return (
        f"live     {r['system']}: {r['rounds']} rounds, {len(lags)} freshness probes, {stale} behind "
        f"(max {max(lags, default=0):.1f}s), {len(r['errors'])} errors"
    )


def concurrency_line(r: ConcurrencyRecord) -> str:
    """One client count of one system, for the console."""
    p50, p95 = r.get("p50_s"), r.get("p95_s")
    times = f"p50 {p50:.3f}s p95 {p95:.3f}s" if p50 is not None and p95 is not None else "no queries"
    return f"clients  {r['system']}+{r['reader']} x{r['clients']}: {r['qps']} q/s, {times}, {r['errors']} errors"


def set_ttfb(ms: int) -> None:
    """Sets the latency the counting proxy adds per request."""
    with urllib.request.urlopen(f"http://{PROXY.admin}/ttfb?ms={ms}", data=b"", timeout=5):  # a POST
        pass


def now() -> str:
    """The current UTC time, ISO 8601."""
    return dt.datetime.now(dt.timezone.utc).isoformat()
