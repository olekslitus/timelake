"""What a run's object-store traffic and storage cost, at the store's list prices.

Prices are AWS's price list for us-east-2, read 2026-10-15 from
https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-2/index.json. Requests are counted
by kind by ``tools/s3proxy`` in AWS mode; targets without counts by kind (a local object store) have no cost. Compute
(the machines running writers, readers or servers) is not included.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Mapping

    from timebench.results import IngestRecord, QueryRecord


@dataclass(frozen=True)
class Prices:
    """One store's prices in dollars."""

    tier1: float
    """Per PUT, COPY, POST or LIST request."""
    tier2: float
    """Per GET, HEAD or other request (DELETE is free)."""
    storage_gb_month: float
    upload_gb: float = 0.0
    retrieval_gb: float = 0.0


PRICES: dict[str, Prices] = {
    "aws-s3": Prices(tier1=0.005 / 1000, tier2=0.0004 / 1000, storage_gb_month=0.023),
    "aws-s3x": Prices(
        tier1=0.00113 / 1000, tier2=0.00003 / 1000, storage_gb_month=0.11, upload_gb=0.0032, retrieval_gb=0.0006
    ),
}
TIER1 = {"PUT", "COPY", "POST", "LIST"}
FREE = {"DELETE"}
GB = 1024**3


def requests_cost(kinds: Mapping[str, float], read_bytes: float, prices: Prices) -> float:
    """Dollars for requests by kind and the bytes they returned."""
    total = 0.0
    for kind, n in kinds.items():
        if kind in FREE or kind.startswith("HTTP"):  # the proxy also reports error codes; not requests to bill
            continue
        total += n * (prices.tier1 if kind in TIER1 else prices.tier2)
    return total + read_bytes / GB * prices.retrieval_gb


def first_run_kinds(r: QueryRecord) -> dict[str, float] | None:
    """Requests by kind in a query's first run: measured per run, or the all-runs split scaled to the first run."""
    if r.get("kinds"):
        return dict(r["kinds"][0])
    total = r.get("kinds_total") or {}
    n = sum(total.values())
    if not n or not r.get("requests"):
        return None
    return {k: v / n * r["requests"][0] for k, v in total.items()}


def query_cost(r: QueryRecord, target: str) -> float | None:
    """Dollars for a query's first run on a priced target (None when the requests weren't counted by kind)."""
    prices = PRICES.get(target)
    kinds = first_run_kinds(r)
    if prices is None or kinds is None:
        return None
    return requests_cost(kinds, r.get("bytes", [0])[0], prices)


def phase_cost(r: IngestRecord, target: str) -> float | None:
    """Dollars for an ingest or maintenance phase's requests (writes are billed per request, uploads per GB)."""
    prices = PRICES.get(target)
    if prices is None or not r.get("kinds"):
        return None
    # Bytes uploaded, approximated by the bytes stored after ingest: a lower bound, as compaction rewrites data.
    uploaded = r.get("bytes", 0) if r["kind"] == "ingest" else 0
    return requests_cost(r["kinds"], 0, prices) + uploaded / GB * prices.upload_gb


def storage_month(nbytes: float, target: str) -> float | None:
    """Dollars a month to keep ``nbytes`` on a priced target."""
    prices = PRICES.get(target)
    return None if prices is None else nbytes / GB * prices.storage_gb_month
