"""Workloads: a dataset at a named scale, the order its rows arrive in, and the queries asked of it.

Adding a workload: subclass ``Workload`` in a module here and add it to ``workloads()``. Its queries live in
``queries/<suite>/queries.sql``, written once with the dialect placeholders of ``timebench.queries``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar

from timebench import DATA
from timebench.queries import raw_queries

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    import pyarrow as pa


@dataclass(frozen=True)
class TableSpec:
    """One table of a workload."""

    name: str
    time_column: str | None = None
    """None for a dimension table."""
    series_key: tuple[str, ...] = ()
    """The columns that identify one series (Timelake's series key; TimescaleDB's segment-by)."""


@dataclass(frozen=True)
class Query:
    """One query, with the dialect placeholders still in."""

    suite: str
    name: str
    sql: str


Batch = tuple[str, "pa.Table"]
"""Rows of one table, committed together."""


class Workload(ABC):
    """A dataset and its queries."""

    name: ClassVar[str]
    title: ClassVar[str]
    scales: ClassVar[dict[str, str]]
    """Scale name -> what it means, smallest first."""
    default_scale: ClassVar[str]
    namespace: ClassVar[str]
    """The namespace (schema) the tables are created in."""
    tables: ClassVar[tuple[TableSpec, ...]]
    suites: ClassVar[tuple[str, ...]]
    """Query suites (``queries/<suite>``)."""
    dashboard_suite: ClassVar[str | None] = None
    """The suite a dashboard runs: probed during ingest and run by the concurrency clients."""
    live_table: ClassVar[str | None] = None
    """The time-series table whose newest timestamp tells how fresh a reader's view is."""
    span_days: ClassVar[float]
    """How many days of data the workload holds (scales its costs to a month)."""

    def __init__(self, scale: str | None = None) -> None:
        scale = scale or self.default_scale
        if scale not in self.scales:
            msg = f"{self.name} has no scale {scale!r} (scales: {', '.join(self.scales)})"
            raise ValueError(msg)
        self.scale = scale

    @property
    def dataset(self) -> str:
        """The workload and scale, e.g. ``tsbs-iot-small``: names data and table directories."""
        return f"{self.name}-{self.scale}"

    @property
    def data_dir(self) -> Path:
        """Where the generated data lives."""
        return DATA / "workloads" / self.dataset

    def params(self) -> dict[str, object]:
        """Settings beyond the scale, recorded with the run."""
        return {}

    def spec(self, table: str) -> TableSpec:
        """A table's spec."""
        return next(t for t in self.tables if t.name == table)

    @abstractmethod
    def prepare(self) -> None:
        """Generates the data, unless it's already there."""

    @abstractmethod
    def schema(self, table: str) -> pa.Schema:
        """A table's schema."""

    @abstractmethod
    def initial(self) -> Iterator[Batch]:
        """Rows loaded before the stream starts (dimension tables), one commit each."""

    @abstractmethod
    def stream(self) -> Iterator[list[Batch]]:
        """The rows as they arrive: one list per arrival (a time window), one commit per table in it."""

    def queries(self) -> list[Query]:
        """All queries of the workload's suites."""
        return [Query(suite, name, sql) for suite in self.suites for name, sql in raw_queries(suite)]

    def dashboard_queries(self) -> list[Query]:
        """The dashboard's queries (none if the workload has no dashboard suite)."""
        return [q for q in self.queries() if q.suite == self.dashboard_suite]

    def freshness_query(self) -> Query | None:
        """The newest timestamp of the live table, in whole epoch seconds."""
        if not self.live_table:
            return None
        time_column = self.spec(self.live_table).time_column
        # Placeholders take no nested parentheses: the maximum comes from a subquery.
        newest = f"SELECT max({time_column}) AS newest FROM {self.live_table}"
        sql = f"SELECT CAST(floor(@EPOCH(newest)) AS BIGINT) AS newest FROM ({newest}) AS t"
        return Query("probe", "freshness", sql)


def workloads() -> dict[str, type[Workload]]:
    """All workloads by name."""
    from timebench.workloads.tsbs_iot import TsbsIot

    return {w.name: w for w in (TsbsIot,)}
