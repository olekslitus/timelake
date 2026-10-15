"""Summarize runs against real S3: local disk vs S3 (and S3 Express, S3 Tables) from one machine.

    python compare_aws.py laptop    run_aws.sh: this laptop against S3 us-east-2 (results/*.laptop-*)
    python compare_aws.py aws       bench/infra/remote.sh: an instance in us-east-2 (results/*.aws-*)

Prints markdown. Latency: geometric means over the queries that succeeded on every target for an engine.
Request cost: S3 list prices for us-east-2 (2026-10), averaged per first-run query.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from dataclasses import dataclass

from timebench import RESULTS
from timebench.results import (
    QueryRecord,
    best_time,
    first_time,
    geomean,
    load_ok,
    order_engines,
    read_jsonl,
)

SUITES = ("tsbs_iot", "iot_point", "tpch", "clickbench")
NAMES = {"local": "local disk", "s3": "S3", "s3x": "S3 Express"}
# $ per request by kind (tier 1: PUT, COPY, POST, LIST; tier 2: GET, HEAD, other) and $ per GB retrieved.
PRICES = {
    "s3": {"tier1": 0.005 / 1000, "tier2": 0.0004 / 1000, "gb_out": 0.0},
    # S3 Express also bills retrieval per GB beyond 512 KB per request; all bytes counted here (upper bound).
    "s3x": {"tier1": 0.00113 / 1000, "tier2": 0.00003 / 1000, "gb_out": 0.0006},
}
TIER1 = {"PUT", "COPY", "POST", "LIST"}

ByTarget = dict[str, dict[str, dict[str, QueryRecord]]]
"""Target -> engine -> query -> record."""


@dataclass(frozen=True)
class Run:
    """Which set of runs to summarize."""

    name: str
    """``laptop`` or ``aws``: the prefix of the results tags."""

    @property
    def targets(self) -> list[str]:
        """Storage targets of the Phase 0 suites."""
        return ["local", "s3"] if self.name == "laptop" else ["local", "s3", "s3x"]

    @property
    def v0_targets(self) -> list[tuple[str, str]]:
        """``(target name in tags and the ingest log, label)``."""
        if self.name == "laptop":
            return [("local", "local disk"), ("aws-s3", "S3"), ("aws-s3tables", "S3 Tables")]
        return [("local", "local disk"), ("s3", "S3"), ("s3x", "S3 Express")]


def first_run_kinds(r: QueryRecord) -> dict[str, float]:
    """Requests by kind in the first run: measured per run, or the all-runs split scaled to the first run's count."""
    if r.get("kinds"):
        return dict(r["kinds"][0])
    total = r.get("kinds_total") or {}
    n = sum(total.values())
    return {k: v / n * r["requests"][0] for k, v in total.items()} if n else {"GET": r["requests"][0]}


def cost(r: QueryRecord, target: str) -> float:
    """Dollars for the first run of a query: requests by tier plus retrieval."""
    p = PRICES[target]
    kinds = first_run_kinds(r)
    reqs = sum(n * (p["tier1"] if k in TIER1 else p["tier2"]) for k, n in kinds.items() if not k.startswith("HTTP"))
    return reqs + r["bytes"][0] / 1e9 * p["gb_out"]


def table(run: Run, by_target: ByTarget) -> None:
    """One row per engine that has results on every target."""
    targets = run.targets
    remote = [t for t in targets if t != "local"]
    head = ["engine"] + [f"{NAMES[t]} {m}" for t in targets for m in ("first", "best")]
    head += [f"{NAMES[t]} ÷ local (first)" for t in remote] + ["requests/query", "MB/query"]
    head += [f"$/1M queries {NAMES[t]}" for t in remote]
    print("| " + " | ".join(head) + " |")
    print("|---|" + "---:|" * (len(head) - 1))
    for e in order_engines(set().union(*(d.keys() for d in by_target.values()))):
        if not all(e in by_target[t] for t in targets):
            continue
        qs = set.intersection(*(set(by_target[t][e]) for t in targets))
        if not qs:
            continue
        f = {t: geomean(first_time(by_target[t][e][q]) for q in qs) for t in targets}
        b = {t: geomean(best_time(by_target[t][e][q]) for q in qs) for t in targets}
        s3 = [by_target["s3"][e][q] for q in qs]
        reqs = sum(r["requests"][0] for r in s3) / len(qs)
        mb = sum(r["bytes"][0] for r in s3) / len(qs) / 1e6
        usd = {t: sum(cost(by_target[t][e][q], t) for q in qs) / len(qs) * 1e6 for t in remote}
        cells = [f"{x[t]:.3f}" for t in targets for x in (f, b)] + [f"{f[t] / f['local']:.1f}×" for t in remote]
        cells += [f"{reqs:.0f}", f"{mb:.1f}"] + [f"{usd[t]:.2f}" for t in remote]
        print(f"| {e} | " + " | ".join(cells) + " |")
    print()


def suites(run: Run) -> None:
    """Phase 0 suites: one table per suite, then the failures."""
    for suite in SUITES:
        by_target = {t: load_ok(RESULTS / f"{suite}.{run.name}-{t}.jsonl") for t in run.targets}
        if not any(by_target.values()):
            continue
        print(f"### {suite}\n")
        table(run, by_target)
        failed: defaultdict[tuple[str, str], list[str]] = defaultdict(list)
        for t in run.targets:
            for r in read_jsonl(RESULTS / f"{suite}.{run.name}-{t}.jsonl"):
                if r["status"] != "ok":
                    failed[(r["engine"], r["status"])].append(f"{r['query']}@{t}")
        if failed:
            print("Failures: " + "; ".join(f"{e} {s}: {', '.join(qs)}" for (e, s), qs in sorted(failed.items())) + "\n")


def proxy_check(run: Run) -> None:
    """Plain DuckDB straight to S3 vs through the proxy."""
    rows = []
    for suite in SUITES:
        direct = load_ok(RESULTS / f"{suite}.{run.name}-s3-direct.jsonl").get("duckdb", {})
        proxied = load_ok(RESULTS / f"{suite}.{run.name}-s3.jsonl").get("duckdb", {})
        qs = set(direct) & set(proxied)
        if qs:
            cells = [geomean(time(r[q]) for q in qs) for time in (first_time, best_time) for r in (direct, proxied)]
            rows.append(f"| {suite} | " + " | ".join(f"{c:.3f}" for c in cells) + " |")
    if rows:
        print("### Proxy overhead (plain DuckDB, S3 Standard)\n")
        print("| suite | direct first | proxied first | direct best | proxied best |")
        print("|---|---:|---:|---:|---:|")
        print("\n".join(rows) + "\n")


def v0_ingest(run: Run) -> None:
    """Ingest and maintenance per system and target (the latest record of each)."""
    recs = read_jsonl(RESULTS / f"v0_ingest.{run.name}.jsonl")
    print("### v0: ingest (1,728 commits, 5-minute windows) and maintenance\n")
    print(
        "| system | target | ingest s | commit p50 ms | commit p95 ms | data files | objects | MB | maintenance s "
        "| data files after | MB after |"
    )
    print("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    last = {(r["system"], r.get("target", r["storage"]), r["phase"]): r for r in recs}
    for system in ("iceberg", "s3tables", "lance", "timelake"):
        for t, label in run.v0_targets:
            i, m = last.get((system, t, "ingest")), last.get((system, t, "maintain"))
            if not i:
                continue
            ms = f"{m['seconds']:.0f} | {m['data_files']} | {m['bytes'] / 1e6:.0f}" if m else "— | — | —"
            objects = i["objects"] if i["objects"] is not None else "n/a"  # S3 Tables storage can't be listed
            print(
                f"| {system} | {label} | {i['seconds']:.0f} | {i['commit_ms_p50']:.0f} | {i['commit_ms_p95']:.0f} "
                f"| {i['data_files']} | {objects} | {i['bytes'] / 1e6:.0f} | {ms} |"
            )
    print()


def v0_queries(run: Run, suite: str) -> None:
    """Geometric means per engine and phase, one column per target."""
    names = [t for t, _ in run.v0_targets]
    print(f"### v0 queries: {suite} (geometric mean seconds, first run / best run)\n")
    print("| engine | phase | " + " | ".join(label for _, label in run.v0_targets) + " | requests/query (S3, first) |")
    print("|---|---|" + "---:|" * (len(names) + 1))
    for phase in ("ingested", "maintained"):
        by_target = {t: load_ok(RESULTS / f"{suite}.v0-{run.name}-{t}-{phase}.jsonl") for t in names}
        for e in order_engines(set().union(*(d.keys() for d in by_target.values()))):
            present = [t for t in names if e in by_target[t]]
            qs = set.intersection(*(set(by_target[t][e]) for t in present))
            cells = [
                f"{geomean(first_time(by_target[t][e][q]) for q in qs):.3f} / "
                f"{geomean(best_time(by_target[t][e][q]) for q in qs):.3f}"
                if t in present and qs
                else "—"
                for t in names
            ]
            remote = [by_target[t][e][q] for t in present if t != "local" for q in qs]
            reqs = (
                f"{sum(r['requests'][0] for r in remote) / len(remote):.0f}"
                if remote and "requests" in remote[0]
                else "—"
            )
            print(f"| {e} | {phase} | " + " | ".join(cells) + f" | {reqs} |")
    print()


def main() -> None:
    """Prints the report."""
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("run", nargs="?", default="laptop", choices=["laptop", "aws"], help="which runs to summarize")
    run = Run(p.parse_args().run)
    suites(run)
    proxy_check(run)
    if (RESULTS / f"v0_ingest.{run.name}.jsonl").exists():
        v0_ingest(run)
        for suite in ("tsbs_iot", "iot_point"):
            v0_queries(run, suite)


if __name__ == "__main__":
    main()
