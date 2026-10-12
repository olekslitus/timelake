"""Compare engines (typically one engine over Parquet vs Vortex) across result files.

    python compare_formats.py rs        # Rust reader: datafusion-rs / -pushdown / -vortex
    python compare_formats.py duckdb    # DuckDB: duckdb / duckdb-vortex

Geometric means (seconds) over queries every listed engine completed; ratios are relative to the first
engine. "first" = first run in a fresh process; "best" = best of the repeat runs.
"""

import json
import math
import sys
from pathlib import Path

RESULTS = Path(__file__).parent / "results"
SETS = {
    "rs": (
        ["datafusion-rs", "datafusion-rs-pushdown", "datafusion-rs-vortex"],
        "rs",
    ),
    "duckdb": (["duckdb", "duckdb-vortex"], "fmt"),
}
WORKLOADS = [
    ("tpch.{t}-local", "TPC-H SF10, local"),
    ("clickbench.{t}-local", "ClickBench 10%, local"),
    ("tsbs_iot.{t}-local-as-is", "TSBS IoT, local, as generated"),
    ("tsbs_iot.{t}-local-sorted", "TSBS IoT, local, sorted"),
    ("iot_point.{t}-local-as-is", "Single-device, local, as generated"),
    ("iot_point.{t}-local-sorted", "Single-device, local, sorted"),
    ("tpch.{t}-s3", "TPC-H SF10, RustFS 20 ms"),
    ("clickbench.{t}-s3", "ClickBench 10%, RustFS 20 ms"),
    ("tsbs_iot.{t}-s3-sorted", "TSBS IoT, RustFS 20 ms, sorted"),
    ("iot_point.{t}-s3-sorted", "Single-device, RustFS 20 ms, sorted"),
]


def gm(xs):
    return math.exp(sum(math.log(max(x, 1e-4)) for x in xs) / len(xs))


def main(which: str):
    engines, tag = SETS[which]
    base = engines[0]
    hdr = " | ".join(f"{e} first | {e} best" for e in engines)
    print(f"| workload | queries | {hdr} | first-run requests/query | first-run MB/query | rows match |")
    print("|---|---:|" + "---:|---:|" * len(engines) + "---|---|---|")
    for pattern, label in WORKLOADS:
        f = RESULTS / (pattern.format(t=tag) + ".jsonl")
        if not f.exists():
            continue
        d = {}
        for line in f.read_text().splitlines():
            r = json.loads(line)
            if r["status"] == "ok":
                d[(r["engine"], r["query"])] = r
        qs = sorted(set.intersection(*({q for (e, q) in d if e == eng} for eng in engines)))
        if not qs:
            continue
        cells = []
        for e in engines:
            first = gm([d[(e, q)]["times"][0] for q in qs])
            best = gm([min(d[(e, q)]["times"][1:]) for q in qs])
            if e == base:
                b_first, b_best = first, best
                cells.append(f"{first:.3f} | {best:.3f}")
            else:
                cells.append(f"{first:.3f} ({first / b_first:.2f}×) | {best:.3f} ({best / b_best:.2f}×)")
        reqs, mb = "", ""
        if "requests" in d[(base, qs[0])]:
            reqs = " / ".join(f"{sum(d[(e, q)]['requests'][0] for q in qs) / len(qs):.0f}" for e in engines)
            mb = " / ".join(f"{sum(d[(e, q)]['bytes'][0] for q in qs) / len(qs) / 1e6:.0f}" for e in engines)
        match = all(len({d[(e, q)]["rows"] for e in engines}) == 1 for q in qs)
        total = len({q for (_, q) in d})
        print(f"| {label} | {len(qs)}/{total} | " + " | ".join(cells) + f" | {reqs} | {mb} | {'✓' if match else '⚠'} |")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "rs")
