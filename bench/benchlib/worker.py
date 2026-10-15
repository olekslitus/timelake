"""Runs one query in a fresh process and prints its measurements as one JSON line (started by ``benchlib.harness``).

    python -m benchlib.worker '{"system": "iceberg", "reader": "duckdb", "target": "local", "dataset": ..., "runs": 2}'

The SQL comes on stdin. The query runs once ("first run": cold metadata, footers and data in this process) and then
``runs`` more times; every run fully materializes the result.
"""

from __future__ import annotations

import json
import sys
import time
from typing import TYPE_CHECKING

from benchlib.s3 import PROXY, ProxyStats
from benchlib.systems import systems
from benchlib.targets import Place, Target

if TYPE_CHECKING:
    from benchlib.results import QueryRecord


def request_kinds(before: ProxyStats, after: ProxyStats) -> dict[str, int]:
    """Requests by kind between two proxy snapshots (kinds that didn't change are left out)."""
    old = before.get("kinds", {})
    return {k: n - old.get(k, 0) for k, n in after.get("kinds", {}).items() if n != old.get(k, 0)}


def main() -> None:
    """Opens the reader, runs the query, prints the record fields."""
    job = json.loads(sys.argv[1])
    sql = sys.stdin.read()
    place = Place(Target(job["target"]), job["dataset"], job["system"])
    system = systems()[job["system"]]
    counted = place.target.s3 and not system.server
    setup_start = time.perf_counter()
    run = system.open_reader(job["reader"], place, place.load_state())
    setup_s = time.perf_counter() - setup_start
    times: list[float] = []
    requests: list[int] = []
    nbytes: list[int] = []
    kinds: list[dict[str, int]] = []
    rows = None
    for _ in range(job["runs"] + 1):
        before = PROXY.stats() if counted else None
        start = time.perf_counter()
        rows = run(sql)
        times.append(time.perf_counter() - start)
        if before:
            after = PROXY.stats()
            requests.append(after["requests"] - before["requests"])
            nbytes.append(after["bytes"] - before["bytes"])
            if "kinds" in after:  # AWS mode: requests by kind (GET, HEAD, LIST, PUT, ...)
                kinds.append(request_kinds(before, after))
    out: QueryRecord = {"times": times, "rows": rows, "setup_s": setup_s}
    if counted:
        out.update(requests=requests, bytes=nbytes)
        if kinds:
            out["kinds"] = kinds
    print(json.dumps(out))


if __name__ == "__main__":
    main()
