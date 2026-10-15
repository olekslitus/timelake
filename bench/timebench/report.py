"""Reading run files back: one run as Markdown, and the history of runs as a table."""

from __future__ import annotations

from collections import defaultdict
from typing import TYPE_CHECKING, Any, cast

from timebench import RUNS
from timebench.results import QueryRecord, best_time, first_time, geomean, read_jsonl

if TYPE_CHECKING:
    from pathlib import Path


class Run:
    """One run file, parsed."""

    def __init__(self, path: Path) -> None:
        records = read_jsonl(path)
        self.path = path
        self.header: dict[str, Any] = records[0]
        self.end: dict[str, Any] | None = next((r for r in records if r.get("kind") == "end"), None)
        self.ingest = [r for r in records if r.get("kind") == "ingest"]
        self.maintain = [r for r in records if r.get("kind") == "maintain"]
        self.queries = [cast("QueryRecord", r) for r in records if r.get("kind") == "query"]

    @property
    def id(self) -> str:
        """The run id."""
        return str(self.header["id"])

    def engines(self) -> list[str]:
        """``system+reader`` pairs, in the order they ran."""
        return list(dict.fromkeys(f"{q['system']}+{q['reader']}" for q in self.queries))

    def checkpoints(self) -> list[str]:
        """Checkpoints with queries, in order."""
        return list(dict.fromkeys(q["checkpoint"] for q in self.queries))

    def ok(self, checkpoint: str) -> dict[str, dict[str, QueryRecord]]:
        """Successful queries at a checkpoint: engine -> query -> record."""
        out: dict[str, dict[str, QueryRecord]] = defaultdict(dict)
        for q in self.queries:
            if q["checkpoint"] == checkpoint and q["status"] == "ok":
                out[f"{q['system']}+{q['reader']}"][q["query"]] = q
        return out

    def summary(self, checkpoint: str) -> dict[str, dict[str, float]]:
        """Per engine: geometric means of first and best run, over the queries every engine completed."""
        ok = self.ok(checkpoint)
        if not ok:
            return {}
        common = set.intersection(*(set(qs) for qs in ok.values()))
        out = {}
        for engine, qs in ok.items():
            rs = [qs[q] for q in sorted(common)]
            out[engine] = {"first": geomean(map(first_time, rs)), "best": geomean(map(best_time, rs))}
            if rs and all("requests" in r for r in rs):
                out[engine]["requests"] = geomean(r["requests"][0] for r in rs)
            out[engine]["queries"] = len(rs)
        return out


def runs(workload: str | None = None, label: str | None = None) -> list[Run]:
    """All runs, oldest first, optionally of one workload or with one label."""
    found = [Run(p) for p in sorted(RUNS.glob("*.jsonl"))]
    return [
        r
        for r in found
        if (workload is None or r.header["workload"] == workload) and (label is None or r.header.get("label") == label)
    ]


def markdown(run: Run) -> str:
    """One run as Markdown: where it ran, ingest and maintenance, query times."""
    h = run.header
    lines = [
        f"# {h['workload']} ({h['scale']}) on {h['target']}",
        "",
        f"Run `{run.id}`: commit `{h['commit'][:10]}`{' (with local changes)' if h.get('dirty') else ''}, "
        f"{h['machine']}, started {h['started']}"
        + (
            f", {run.end['seconds'] / 60:.0f} min"
            if run.end and "seconds" in run.end
            else ""
            if run.end
            else " (incomplete)"
        )
        + ".",
        "",
        "| Phase | System | Seconds | Commits | Commit p50 | Commit p95 | Objects | Bytes | Requests | Status |",
        "|---|---|--:|--:|--:|--:|--:|--:|--:|---|",
    ]
    lines.extend(
        f"| {r['kind']} | {r['system']} | {cell(r, 'seconds')} | {cell(r, 'commits')} | "
        f"{cell(r, 'commit_ms_p50')} | {cell(r, 'commit_ms_p95')} | {cell(r, 'objects')} | "
        f"{cell(r, 'bytes')} | {cell(r, 'requests')} | {r['status']} |"
        for r in run.ingest + run.maintain
    )
    for checkpoint in run.checkpoints():
        lines += ["", f"## Queries, {checkpoint}", ""]
        summary = run.summary(checkpoint)
        lines += ["| Engine | Queries | First run (geomean) | Best repeat (geomean) | Requests (first run) |"]
        lines += ["|---|--:|--:|--:|--:|"]
        for engine, s in sorted(summary.items(), key=lambda kv: kv[1]["first"]):
            reqs = f"{s['requests']:.0f}" if "requests" in s else ""
            lines.append(f"| {engine} | {s['queries']:.0f} | {s['first']:.3f} s | {s['best']:.3f} s | {reqs} |")
        failed = [q for q in run.queries if q["checkpoint"] == checkpoint and q["status"] != "ok"]
        if failed:
            lines += [
                "",
                "Failed: " + ", ".join(f"{q['system']}+{q['reader']} {q['query']} ({q['status']})" for q in failed),
            ]
    if run.end and run.end.get("mismatches"):
        lines += ["", "Row counts differ: " + "; ".join(run.end["mismatches"])]
    return "\n".join(lines) + "\n"


def history(found: list[Run], checkpoint: str = "maintained") -> str:
    """One line per run: first-run geometric mean per engine at a checkpoint."""
    engines = list(dict.fromkeys(e for r in found for e in r.engines()))
    lines = [
        "| Run | Commit | Target | " + " | ".join(engines) + " |",
        "|---|---|---|" + "--:|" * len(engines),
    ]
    for r in found:
        summary = r.summary(checkpoint)
        cells = [f"{summary[e]['first']:.3f}" if e in summary else "" for e in engines]
        lines.append(f"| {r.id} | {r.header['commit'][:7]} | {r.header['target']} | " + " | ".join(cells) + " |")
    return "\n".join(lines) + "\n"


def cell(record: dict[str, Any], key: str) -> str:
    """A table cell: the value, or nothing when it's missing or null."""
    value = record.get(key)
    return "" if value is None else str(value)
