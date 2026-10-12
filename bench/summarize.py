"""Summarize results/*.jsonl into markdown tables (printed to stdout).

Per query: best repeat-run time per engine (seconds), or ERR / T/O. Per engine: geometric mean over the
queries that succeeded on *all* engines in the suite, plus the number of failures. Row-count
disagreements between engines are flagged, since every engine runs the same logical query.
"""

import json
import math
import sys
from collections import defaultdict
from pathlib import Path

RESULTS = Path(__file__).parent / "results"
ENGINE_ORDER = ["duckdb", "duckdb-iceberg", "datafusion", "polars", "timescaledb"]


def load(suite: str):
    recs = [json.loads(l) for l in (RESULTS / f"{suite}.jsonl").read_text().splitlines() if l.strip()]
    by_query: dict[str, dict[str, dict]] = defaultdict(dict)
    versions = {}
    for r in recs:
        by_query[r["query"]][r["engine"]] = r
        versions[r["engine"]] = r["version"]
    engines = sorted(versions, key=lambda e: ENGINE_ORDER.index(e) if e in ENGINE_ORDER else 99)
    return by_query, engines, versions


METRIC = "best"  # or "first": the first run in a fresh process (no in-process caches)


def best(r: dict) -> float:
    if METRIC == "first":
        return r["times"][0]
    return min(r["times"][1:] or r["times"])


def cell(r: dict | None) -> str:
    if r is None:
        return "—"
    if r["status"] == "ok":
        return f"{best(r):.3f}"
    return "T/O" if r["status"] == "timeout" else "ERR"


def summarize(suite: str):
    by_query, engines, versions = load(suite)
    print(f"### {suite} ({METRIC} run)\n")
    print("| query | " + " | ".join(f"{e} {versions[e]}" for e in engines) + " | rows |")
    print("|---|" + "---:|" * len(engines) + "---|")
    common, failures = [], defaultdict(int)
    for q, per in by_query.items():
        rows = {per[e]["rows"] for e in engines if e in per and per[e]["status"] == "ok" and per[e]["rows"] is not None}
        mismatch = " ⚠ mismatch" if len(rows) > 1 else ""
        # Mark the fastest engine per query in bold.
        oks = {e: best(per[e]) for e in engines if e in per and per[e]["status"] == "ok"}
        fastest = min(oks, key=oks.get) if oks else None
        cells = [f"**{cell(per.get(e))}**" if e == fastest and len(oks) > 1 else cell(per.get(e)) for e in engines]
        print(f"| {q} | " + " | ".join(cells) + f" | {'/'.join(map(str, sorted(rows)))}{mismatch} |")
        for e in engines:
            if e not in per or per[e]["status"] != "ok":
                failures[e] += 1
        if all(e in per and per[e]["status"] == "ok" for e in engines):
            common.append(q)
    print()
    print(f"Geometric mean of {METRIC}-run times over the {len(common)} queries every engine completed, and failures:\n")
    has_reqs = any("requests" in by_query[q][e] for q in common for e in engines)
    print("| engine | geomean (s) | relative | failed |" + (" first-run requests (sum) | first-run MB (sum) | setup s (median) |" if has_reqs else ""))
    print("|---|---:|---:|---:|" + ("---:|---:|---:|" if has_reqs else ""))
    gms = {}
    for e in engines:
        ts = [best(by_query[q][e]) for q in common]
        gms[e] = math.exp(sum(math.log(max(t, 1e-4)) for t in ts) / len(ts)) if ts else float("nan")
    base = min(gms.values())
    for e in engines:
        extra = ""
        if has_reqs:
            rs = [by_query[q][e] for q in common]
            setups = sorted(r.get("setup_s", 0) for r in rs)
            extra = (f" {sum(r['requests'][0] for r in rs)} | {sum(r['bytes'][0] for r in rs) / 1e6:.0f} |"
                     f" {setups[len(setups) // 2]:.2f} |")
        print(f"| {e} | {gms[e]:.3f} | {gms[e] / base:.2f}× | {failures[e]} |" + extra)
    print()
    errors = [(q, e, r.get("error", r["status"])) for q, per in by_query.items() for e, r in per.items() if r["status"] != "ok"]
    if errors:
        print("<details><summary>Failures</summary>\n")
        for q, e, err in errors:
            print(f"- `{e}` {q}: {err[:200]}")
        print("\n</details>\n")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0].startswith("--metric="):
        METRIC = args.pop(0).split("=", 1)[1]
    for suite in args or ["tsbs_iot", "tpch", "clickbench"]:
        if (RESULTS / f"{suite}.jsonl").exists():
            summarize(suite)
