"""Compare local disk vs RustFS (0 ms / 20 ms TTFB) per suite and engine.

Geometric means over the queries that succeeded in *all* configurations for that engine, for the first
run (fresh process, no in-process caches) and the best repeat run.
"""

import json
import math
from collections import defaultdict
from pathlib import Path

RESULTS = Path(__file__).parent / "results"
CONFIGS = [("local", "{s}.jsonl"), ("rustfs 0 ms", "{s}.rustfs-0ms.jsonl"), ("rustfs 20 ms", "{s}.rustfs-20ms.jsonl")]


def gm(xs):
    return math.exp(sum(math.log(max(x, 1e-4)) for x in xs) / len(xs)) if xs else float("nan")


for suite in ["tsbs_iot", "tpch", "clickbench"]:
    data = defaultdict(dict)  # (engine, config) -> {query: rec}
    for cfg, pat in CONFIGS:
        f = RESULTS / pat.format(s=suite)
        if not f.exists():
            continue
        for line in f.read_text().splitlines():
            r = json.loads(line)
            if r["status"] == "ok":
                data[(r["engine"], cfg)][r["query"]] = r
    engines = sorted({e for e, _ in data}, key=lambda e: ["duckdb", "duckdb-iceberg", "datafusion", "polars"].index(e) if e in ["duckdb", "duckdb-iceberg", "datafusion", "polars"] else 9)
    print(f"### {suite}\n")
    print("| engine | local first | local best | 0 ms first | 20 ms first | 20 ms best | 20 ms first ÷ local first | reqs/query (first) | MB/query (first) |")
    print("|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    for e in engines:
        cfgs = [c for c, _ in CONFIGS if (e, c) in data]
        if len(cfgs) < 3:
            continue
        qs = set.intersection(*(set(data[(e, c)]) for c in cfgs))
        first = {c: gm([data[(e, c)][q]["times"][0] for q in qs]) for c in cfgs}
        bestv = {c: gm([min(data[(e, c)][q]["times"][1:]) for q in qs]) for c in cfgs}
        s20 = [data[(e, "rustfs 20 ms")][q] for q in qs]
        reqs = sum(r["requests"][0] for r in s20) / len(qs)
        mb = sum(r["bytes"][0] for r in s20) / len(qs) / 1e6
        print(f"| {e} | {first['local']:.3f} | {bestv['local']:.3f} | {first['rustfs 0 ms']:.3f} | {first['rustfs 20 ms']:.3f} | "
              f"{bestv['rustfs 20 ms']:.3f} | {first['rustfs 20 ms'] / first['local']:.1f}× | {reqs:.1f} | {mb:.1f} |")
    print()
