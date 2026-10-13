"""Summarize runs against real S3: local disk vs S3 (and S3 Express, S3 Tables) from one machine.

    python compare_aws.py laptop    run_aws.sh: this laptop against S3 us-east-2 (results/*.laptop-*)
    python compare_aws.py aws       bench/infra/remote.sh: an instance in us-east-2 (results/*.aws-*)

Prints markdown. Latency: geometric means over the queries that succeeded on every target for an engine.
Request cost: S3 list prices for us-east-2 (2026-10), averaged per first-run query.
"""

import json
import math
import sys
from collections import defaultdict
from pathlib import Path

RESULTS = Path(__file__).parent / "results"
RUN = sys.argv[1] if len(sys.argv) > 1 else "laptop"
TARGETS = ["local", "s3"] if RUN == "laptop" else ["local", "s3", "s3x"]
# v0 targets: (state name used in tags and the ingest log, label)
V0_TARGETS = ([("local", "local disk"), ("aws-s3", "S3"), ("aws-s3tables", "S3 Tables")] if RUN == "laptop"
              else [("local", "local disk"), ("s3", "S3"), ("s3x", "S3 Express")])
NAMES = {"local": "local disk", "s3": "S3", "s3x": "S3 Express"}
# $ per request by kind (tier 1: PUT, COPY, POST, LIST; tier 2: GET, HEAD, other) and $ per GB retrieved.
PRICES = {
    "s3": {"tier1": 0.005 / 1000, "tier2": 0.0004 / 1000, "gb_out": 0.0},
    # S3 Express also bills retrieval per GB beyond 512 KB per request; all bytes counted here (upper bound).
    "s3x": {"tier1": 0.00113 / 1000, "tier2": 0.00003 / 1000, "gb_out": 0.0006},
}
TIER1 = {"PUT", "COPY", "POST", "LIST"}
ENGINE_ORDER = ["duckdb", "duckdb-iceberg", "duckdb-vortex", "datafusion", "datafusion-rs", "datafusion-rs-vortex",
                "polars", "v0-iceberg", "v0-s3tables", "v0-lance-duckdb", "v0-lance-df", "v0-timelake",
                "v0-timelake-duckdb"]


def gm(xs):
    return math.exp(sum(math.log(max(x, 1e-4)) for x in xs) / len(xs)) if xs else float("nan")


def first(r):
    return r["times"][0]


def best(r):
    return min(r["times"][1:] or r["times"])


def load(path: Path) -> dict[str, dict[str, dict]]:
    """engine -> query -> record (successful runs only)."""
    out: dict[str, dict[str, dict]] = defaultdict(dict)
    if path.exists():
        for line in path.read_text().splitlines():
            r = json.loads(line)
            if r["status"] == "ok":
                out[r["engine"]][r["query"]] = r
    return out


def first_run_kinds(r: dict) -> dict[str, float]:
    """Requests by kind in the first run: measured per run, or the all-runs split scaled to the first run's count."""
    if r.get("kinds"):
        return r["kinds"][0]
    total = r.get("kinds_total") or {}
    n = sum(total.values())
    return {k: v / n * r["requests"][0] for k, v in total.items()} if n else {"GET": r["requests"][0]}


def cost(r: dict, target: str) -> float:
    p = PRICES[target]
    kinds = first_run_kinds(r)
    reqs = sum(n * (p["tier1"] if k in TIER1 else p["tier2"]) for k, n in kinds.items() if not k.startswith("HTTP"))
    return reqs + r["bytes"][0] / 1e9 * p["gb_out"]


def order(engines):
    return sorted(engines, key=lambda e: ENGINE_ORDER.index(e) if e in ENGINE_ORDER else 99)


def table(by_target: dict[str, dict[str, dict[str, dict]]]):
    remote = [t for t in TARGETS if t != "local"]
    head = ["engine"] + [f"{NAMES[t]} {m}" for t in TARGETS for m in ("first", "best")]
    head += [f"{NAMES[t]} ÷ local (first)" for t in remote] + ["requests/query", "MB/query"]
    head += [f"$/1M queries {NAMES[t]}" for t in remote]
    print("| " + " | ".join(head) + " |")
    print("|---|" + "---:|" * (len(head) - 1))
    for e in order(set().union(*(d.keys() for d in by_target.values()))):
        if not all(e in by_target[t] for t in TARGETS):
            continue
        qs = set.intersection(*(set(by_target[t][e]) for t in TARGETS))
        if not qs:
            continue
        f = {t: gm([first(by_target[t][e][q]) for q in qs]) for t in TARGETS}
        b = {t: gm([best(by_target[t][e][q]) for q in qs]) for t in TARGETS}
        s3 = [by_target["s3"][e][q] for q in qs]
        reqs = sum(r["requests"][0] for r in s3) / len(qs)
        mb = sum(r["bytes"][0] for r in s3) / len(qs) / 1e6
        usd = {t: sum(cost(by_target[t][e][q], t) for q in qs) / len(qs) * 1e6 for t in remote}
        cells = [f"{x[t]:.3f}" for t in TARGETS for x in (f, b)] + [f"{f[t] / f['local']:.1f}×" for t in remote]
        cells += [f"{reqs:.0f}", f"{mb:.1f}"] + [f"{usd[t]:.2f}" for t in remote]
        print(f"| {e} | " + " | ".join(cells) + " |")
    print()


def suites():
    for suite in ["tsbs_iot", "iot_point", "tpch", "clickbench"]:
        by_target = {t: load(RESULTS / f"{suite}.{RUN}-{t}.jsonl") for t in TARGETS}
        if not any(by_target.values()):
            continue
        print(f"### {suite}\n")
        table(by_target)
        failed = defaultdict(list)
        for t in TARGETS:
            p = RESULTS / f"{suite}.{RUN}-{t}.jsonl"
            for line in p.read_text().splitlines() if p.exists() else []:
                r = json.loads(line)
                if r["status"] != "ok":
                    failed[(r["engine"], r["status"])].append(f"{r['query']}@{t}")
        if failed:
            print("Failures: " + "; ".join(f"{e} {s}: {', '.join(qs)}" for (e, s), qs in sorted(failed.items())) + "\n")


def proxy_check():
    rows = []
    for suite in ["tsbs_iot", "iot_point", "tpch", "clickbench"]:
        d = load(RESULTS / f"{suite}.{RUN}-s3-direct.jsonl").get("duckdb", {})
        p = load(RESULTS / f"{suite}.{RUN}-s3.jsonl").get("duckdb", {})
        qs = set(d) & set(p)
        if qs:
            rows.append(f"| {suite} | {gm([first(d[q]) for q in qs]):.3f} | {gm([first(p[q]) for q in qs]):.3f} "
                        f"| {gm([best(d[q]) for q in qs]):.3f} | {gm([best(p[q]) for q in qs]):.3f} |")
    if rows:
        print("### Proxy overhead (plain DuckDB, S3 Standard)\n")
        print("| suite | direct first | proxied first | direct best | proxied best |")
        print("|---|---:|---:|---:|---:|")
        print("\n".join(rows) + "\n")


def v0():
    p = RESULTS / f"v0_ingest.{RUN}.jsonl"
    if not p.exists():
        return
    recs = [json.loads(l) for l in p.read_text().splitlines() if l.strip()]
    print("### v0: ingest (1,728 commits, 5-minute windows) and maintenance\n")
    print("| system | target | ingest s | commit p50 ms | commit p95 ms | data files | objects | MB | maintenance s "
          "| data files after | MB after |")
    print("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    last = {}
    for r in recs:
        last[(r["system"], r.get("target", r["storage"]), r["phase"])] = r
    for system in ["iceberg", "s3tables", "lance", "timelake"]:
        for t, label in V0_TARGETS:
            i, m = last.get((system, t, "ingest")), last.get((system, t, "maintain"))
            if not i:
                continue
            ms = f"{m['seconds']:.0f} | {m['data_files']} | {m['bytes'] / 1e6:.0f}" if m else "— | — | —"
            print(f"| {system} | {label} | {i['seconds']:.0f} | {i['commit_ms_p50']:.0f} | {i['commit_ms_p95']:.0f} "
                  f"| {i['data_files']} | {i['objects']} | {i['bytes'] / 1e6:.0f} | {ms} |")
            if m and m.get("compaction_after_ingest_s"):
                print(f"\nS3 Tables managed compaction ran {m['compaction_after_ingest_s']} s after ingest ended (per table).\n")
    print()
    for suite in ["tsbs_iot", "iot_point"]:
        print(f"### v0 queries: {suite} (geometric mean seconds, first run / best run)\n")
        names = [t for t, _ in V0_TARGETS]
        print("| engine | phase | " + " | ".join(label for _, label in V0_TARGETS) + " | requests/query (S3, first) |")
        print("|---|---|" + "---:|" * (len(names) + 1))
        for phase in ["ingested", "maintained"]:
            by_target = {t: load(RESULTS / f"{suite}.v0-{RUN}-{t}-{phase}.jsonl") for t in names}
            for e in order(set().union(*(d.keys() for d in by_target.values()))):
                present = [t for t in names if e in by_target[t]]
                qs = set.intersection(*(set(by_target[t][e]) for t in present))
                cells = [f"{gm([first(by_target[t][e][q]) for q in qs]):.3f} / {gm([best(by_target[t][e][q]) for q in qs]):.3f}"
                         if t in present and qs else "—" for t in names]
                remote = [by_target[t][e][q] for t in present if t != "local" for q in qs]
                reqs = f"{sum(r['requests'][0] for r in remote) / len(remote):.0f}" if remote and "requests" in remote[0] else "—"
                print(f"| {e} | {phase} | " + " | ".join(cells) + f" | {reqs} |")
        print()


if __name__ == "__main__":
    suites()
    proxy_check()
    v0()
