"""Markdown summary of the v0 benchmark: ingest, maintenance, and query results.

python v0/summarize.py > results/V0.md
"""

from __future__ import annotations

import argparse
from typing import Any, cast

from benchlib import RESULTS
from benchlib.results import QueryRecord, best_time, first_time, geomean, order_engines, read_jsonl

LABEL = {
    "v0-iceberg": "Iceberg (PyIceberg appends) + DuckDB",
    "v0-lance-duckdb": "Lance + DuckDB",
    "v0-lance-df": "Lance + DataFusion (Lance scanner)",
    "v0-timelake": "**Timelake reader**",
    "v0-timelake-duckdb": "Timelake tables + plain DuckDB",
}
"""The engines in the report, and their names."""

Results = dict[tuple[str, str], QueryRecord]
"""(engine, query) -> record, for one suite."""


def latest_ingest_records(recs: list[dict[str, Any]]) -> dict[tuple[str, str, str], dict[str, Any]]:
    """The latest record per (system, target, phase).

    Keyed by target, not storage: S3 Standard and S3 Express runs both have storage "s3".
    """
    return {(r["system"], r.get("target", r["storage"]), r["phase"]): r for r in recs}


def ingest_tables() -> list[str]:
    """Ingest and maintenance tables, one row per target and system."""
    latest = latest_ingest_records(read_jsonl(RESULTS / "v0_ingest.jsonl"))
    last = sorted(latest.items(), key=lambda kv: (kv[0][1], kv[0][0]))  # by target, then system
    out = [
        "### Ingest: 864 five-minute windows × 2 tables = 1,728 commits, 23.3M rows",
        "",
        "| storage | system | wall time | commit p50 | commit p95 | commit max | objects | total MB | data files |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for (system, target, phase), r in last:
        if phase != "ingest":
            continue
        extra = f" ({r['inline_compactions']} inline compactions)" if "inline_compactions" in r else ""
        out.append(
            f"| {target} | {system}{extra} | {r['seconds']:.1f} s | {r['commit_ms_p50']:.0f} ms | "
            f"{r['commit_ms_p95']:.0f} ms | {r['commit_ms_max']:.0f} ms | {r['objects']} | {r['bytes'] / 1e6:.0f} | "
            f"{r['data_files']} |"
        )
    out += [
        "",
        "### Maintenance (each system's standard compaction + cleanup)",
        "",
        "| storage | system | time | objects after | total MB after | data files after |",
        "|---|---|---:|---:|---:|---:|",
    ]
    for (system, target, phase), r in last:
        if phase == "maintain":
            out.append(
                f"| {target} | {system} | {r['seconds']:.1f} s | {r['objects']} | {r['bytes'] / 1e6:.0f} "
                f"| {r['data_files']} |"
            )
    return out


def load_suites(tag: str) -> dict[str, Results]:
    """Query records of both suites for one results tag; suites without results are left out."""
    data: dict[str, Results] = {}
    for suite in ("tsbs_iot", "iot_point"):
        for r in read_jsonl(RESULTS / f"{suite}.{tag}.jsonl"):
            data.setdefault(suite, {})[(r["engine"], r["query"])] = cast("QueryRecord", r)
    return data


def geomean_rows(data: dict[str, Results], engines: list[str]) -> list[str]:
    """Geometric means per engine over the queries every engine completed, relative to the fastest."""
    cells: dict[str, list[str]] = {e: [] for e in engines}
    notes = []
    for suite, d in data.items():
        qs = sorted({q for (_, q) in d})
        ok = [q for q in qs if all(d.get((e, q), {}).get("status") == "ok" for e in engines)]
        means = {
            e: (geomean(first_time(d[(e, q)]) for q in ok), geomean(best_time(d[(e, q)]) for q in ok)) for e in engines
        }
        fastest_first = min(f for f, _ in means.values())
        fastest_best = min(b for _, b in means.values())
        for e, (f, b) in means.items():
            cells[e].append(f"{f:.3f} ({f / fastest_first:.1f}×) | {b:.3f} ({b / fastest_best:.1f}×)")
        notes.append(f"{suite}: {len(ok)}/{len(qs)} queries completed by all engines")
    out = [
        "| engine | " + " | ".join(f"{s} first (s) | {s} best (s)" for s in data) + " |",
        "|---|" + "---:|---:|" * len(data),
    ]
    out += [f"| {LABEL[e]} | " + " | ".join(cells[e]) + " |" for e in engines]
    return [*out, "", "_" + "; ".join(notes) + ". Geometric means; (n×) = relative to the fastest._", ""]


def per_query_rows(suite: str, d: Results, engines: list[str]) -> list[str]:
    """First-run seconds (and S3 requests) per query, in a collapsed section."""
    names = [LABEL[e].strip("*") for e in engines]
    qs = list(dict.fromkeys(q for (_, q) in d))
    out = [
        f"<details><summary>{suite} per query, first run (s)</summary>",
        "",
        "| query | " + " | ".join(names) + " | rows match |",
        "|---|" + "---:|" * len(engines) + "---|",
    ]
    for q in qs:
        cells, rowset = [], set()
        for e in engines:
            r = d.get((e, q))
            if not r or r.get("status") != "ok":
                cells.append(r.get("status", "-") if r else "-")
                continue
            cells.append(f"{first_time(r):.3f}")
            rowset.add(r["rows"])
        match = "✓" if len(rowset) <= 1 else "⚠ " + str(sorted(rowset))
        out.append(f"| {q} | " + " | ".join(cells) + f" | {match} |")
    if "requests" in next(iter(d.values()), {}):
        out += ["", "First-run requests per query:", "", "| query | " + " | ".join(names) + " |"]
        out.append("|---|" + "---:|" * len(engines))
        for q in qs:
            requests = [
                str(d[(e, q)]["requests"][0]) if d.get((e, q), {}).get("status") == "ok" else "-" for e in engines
            ]
            out.append(f"| {q} | " + " | ".join(requests) + " |")
    return [*out, "", "</details>", ""]


def query_tables(storage: str, phase: str) -> list[str]:
    """Query results for one storage and phase (results tag ``v0-<storage>-<phase>``)."""
    data = load_suites(f"v0-{storage}-{phase}")
    if not data:
        return []
    present = {e for d in data.values() for (e, _) in d}
    engines = [e for e in order_engines(present) if e in LABEL]
    out = [f"### Queries: {storage}, after {phase}", "", *geomean_rows(data, engines)]
    for suite, d in data.items():
        out += per_query_rows(suite, d, engines)
    return out


def main() -> None:
    """Prints the report."""
    lines = [*ingest_tables(), ""]
    for storage in ("local", "s3"):
        for phase in ("ingested", "maintained"):
            lines += query_tables(storage, phase)
    print("\n".join(lines))


if __name__ == "__main__":
    argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter).parse_args()
    main()
