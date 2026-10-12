"""Markdown summary of the v0 benchmark: ingest, maintenance, and query results.

    python v0/summarize.py > results/V0.md
"""

import json
import math
from collections import defaultdict
from pathlib import Path

RESULTS = Path(__file__).resolve().parent.parent / "results"
ENGINES = ["v0-iceberg", "v0-lance-duckdb", "v0-lance-df", "v0-timelake", "v0-timelake-duckdb"]
LABEL = {
    "v0-iceberg": "Iceberg (PyIceberg appends) + DuckDB",
    "v0-lance-duckdb": "Lance + DuckDB",
    "v0-lance-df": "Lance + DataFusion (Lance scanner)",
    "v0-timelake": "**Timelake reader**",
    "v0-timelake-duckdb": "Timelake tables + plain DuckDB",
}


def gm(xs):
    return math.exp(sum(math.log(max(x, 1e-4)) for x in xs) / len(xs))


def load(path):
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()] if path.exists() else []


def ingest_tables():
    recs = load(RESULTS / "v0_ingest.jsonl")
    last = {}
    for r in recs:  # keep the latest record per (system, storage, phase)
        last[(r["system"], r["storage"], r["phase"])] = r
    out = ["### Ingest: 864 five-minute windows × 2 tables = 1,728 commits, 23.3M rows", "",
           "| storage | system | wall time | commit p50 | commit p95 | commit max | objects | total MB | data files |",
           "|---|---|---:|---:|---:|---:|---:|---:|---:|"]
    for (s, st, ph), r in sorted(last.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        if ph != "ingest":
            continue
        extra = f" ({r['inline_compactions']} inline compactions)" if "inline_compactions" in r else ""
        out.append(f"| {st} | {s}{extra} | {r['seconds']:.1f} s | {r['commit_ms_p50']:.0f} ms | {r['commit_ms_p95']:.0f} ms | "
                   f"{r['commit_ms_max']:.0f} ms | {r['objects']} | {r['bytes'] / 1e6:.0f} | {r['data_files']} |")
    out += ["", "### Maintenance (each system's standard compaction + cleanup)", "",
            "| storage | system | time | objects after | total MB after | data files after |", "|---|---|---:|---:|---:|---:|"]
    for (s, st, ph), r in sorted(last.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        if ph == "maintain":
            out.append(f"| {st} | {s} | {r['seconds']:.1f} s | {r['objects']} | {r['bytes'] / 1e6:.0f} | {r['data_files']} |")
    return out


def query_tables(storage, phase):
    tag = f"v0-{storage}-{phase}"
    data = defaultdict(dict)
    for suite in ("tsbs_iot", "iot_point"):
        for r in load(RESULTS / f"{suite}.{tag}.jsonl"):
            data[suite][(r["engine"], r["query"])] = r
    if not data:
        return []
    out = [f"### Queries: {storage}, after {phase}", ""]
    engines = [e for e in ENGINES if any(e == k[0] for d in data.values() for k in d)]
    # Geomeans over queries every engine completed.
    out += ["| engine | " + " | ".join(f"{s} first (s) | {s} best (s)" for s in data) + " |",
            "|---|" + "---:|---:|" * len(data)]
    rows = {e: [] for e in engines}
    for suite, d in data.items():
        qs = sorted({q for (_, q) in d})
        ok = [q for q in qs if all(d.get((e, q), {}).get("status") == "ok" for e in engines)]
        base = {}
        for e in engines:
            f = gm([d[(e, q)]["times"][0] for q in ok]) if ok else float("nan")
            b = gm([min(d[(e, q)]["times"][1:] or d[(e, q)]["times"]) for q in ok]) if ok else float("nan")
            base[e] = (f, b)
        fmin = min(v[0] for v in base.values())
        bmin = min(v[1] for v in base.values())
        for e in engines:
            f, b = base[e]
            rows[e].append(f"{f:.3f} ({f / fmin:.1f}×) | {b:.3f} ({b / bmin:.1f}×)")
        out_note = f"{suite}: {len(ok)}/{len(qs)} queries completed by all engines"
        rows.setdefault("_notes", []).append(out_note)
    for e in engines:
        out.append(f"| {LABEL[e]} | " + " | ".join(rows[e]) + " |")
    out += ["", "_" + "; ".join(rows["_notes"]) + ". Geometric means; (n×) = relative to the fastest._", ""]
    # Per-query first runs.
    for suite, d in data.items():
        qs = list(dict.fromkeys(q for (_, q) in d))
        out += [f"<details><summary>{suite} per query, first run (s)</summary>", "",
                "| query | " + " | ".join(LABEL[e].strip("*") for e in engines) + " | rows match |",
                "|---|" + "---:|" * len(engines) + "---|"]
        for q in qs:
            cells, rowset = [], set()
            for e in engines:
                r = d.get((e, q))
                if not r or r.get("status") != "ok":
                    cells.append(r.get("status", "-") if r else "-")
                    continue
                cells.append(f"{r['times'][0]:.3f}")
                rowset.add(r["rows"])
            out.append(f"| {q} | " + " | ".join(cells) + f" | {'✓' if len(rowset) <= 1 else '⚠ ' + str(sorted(rowset))} |")
        if "requests" in next(iter(d.values()), {}):
            out += ["", "First-run requests per query:", "",
                    "| query | " + " | ".join(LABEL[e].strip("*") for e in engines) + " |", "|---|" + "---:|" * len(engines)]
            for q in qs:
                out.append(f"| {q} | " + " | ".join(
                    str(d[(e, q)]["requests"][0]) if d.get((e, q), {}).get("status") == "ok" else "-" for e in engines) + " |")
        out += ["", "</details>", ""]
    return out


def main():
    lines = ingest_tables() + [""]
    for storage in ("local", "s3"):
        for phase in ("ingested", "maintained"):
            lines += query_tables(storage, phase)
    print("\n".join(lines))


if __name__ == "__main__":
    main()
