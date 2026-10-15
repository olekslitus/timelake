"""How much S3 request and byte counts vary between identical runs (spikes/request-counts/README.md).

    uv run python spikes/request-counts/compare.py RUN_FILE RUN_FILE [...]

Prints, per system and phase, how many measurements were identical in every run and the largest relative spread.
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path


def spread(values: list[int]) -> float:
    """(max - min) / max, 0 when all are equal."""
    return (max(values) - min(values)) / max(values) if max(values) else 0.0


def main(paths: list[Path]) -> None:
    """Compares the runs and prints a Markdown table."""
    series: dict[tuple[str, str], dict[str, list[int]]] = defaultdict(lambda: defaultdict(list))
    for path in paths:
        for line in path.read_text().splitlines():
            r = json.loads(line)
            if r["kind"] in ("ingest", "maintain") and "requests" in r:
                series[(r["system"], r["kind"])]["requests"].append(r["requests"])
            elif r["kind"] == "query" and r["status"] == "ok" and "requests" in r:
                key = (f"{r['system']}+{r['reader']}", f"query ({r['checkpoint']})")
                name = r["query"]
                series[key][f"{name} first-run requests"].append(r["requests"][0])
                series[key][f"{name} first-run bytes"].append(r["bytes"][0])
                series[key][f"{name} repeat requests"].append(min(r["requests"][1:]))
    print("| System | Phase | Measurements | Identical in every run | Largest spread | Where |")
    print("|---|---|--:|--:|--:|---|")
    for (system, phase), measures in sorted(series.items()):
        complete = {k: v for k, v in measures.items() if len(v) == len(paths)}
        same = sum(1 for v in complete.values() if len(set(v)) == 1)
        worst = max(complete.items(), key=lambda kv: spread(kv[1]), default=("", [0]))
        where = f"{worst[0]}: {worst[1]}" if spread(worst[1]) else ""
        print(f"| {system} | {phase} | {len(complete)} | {same} | {spread(worst[1]):.1%} | {where} |")


if __name__ == "__main__":
    main([Path(p) for p in sys.argv[1:]])
