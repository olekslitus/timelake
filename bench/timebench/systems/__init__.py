"""The systems under test: one adapter per table format or database, each used the way its docs suggest.

A system writes a workload's tables (``create``, ``append`` per commit, ``maintain``) and has one or more readers,
the query engines that read those tables. Each query runs in a fresh process: ``timebench.worker`` opens the reader
with ``System.open_reader``, or a reader in ``System.commands`` is its own binary (``reader_command``).

Adding a system: subclass ``System`` in a module here and add it to ``SYSTEMS``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, ClassVar

from timebench.queries import DATAFUSION, DUCKDB, POLARS, TIMESCALEDB, Dialect

if TYPE_CHECKING:
    import pyarrow as pa

    from timebench.results import IngestRecord
    from timebench.targets import Place, StorageStats, Target
    from timebench.workloads import TableSpec

Runner = Callable[[str], int]
"""Runs one query, fully materializing the result; returns the number of rows."""

DIALECTS: dict[str, Dialect] = {
    "duckdb": DUCKDB,
    "datafusion": DATAFUSION,
    "timelake": DATAFUSION,
    "polars": POLARS,
    "postgres": TIMESCALEDB,
}
"""The SQL dialect of each reader."""


class System(ABC):
    """One system under test, for one dataset on one target."""

    name: ClassVar[str]
    title: ClassVar[str]
    """How reports name it."""
    readers: ClassVar[tuple[str, ...]]
    """Its readers; the first is the system's own."""
    commands: ClassVar[frozenset[str]] = frozenset()
    """Readers that are their own binary (``reader_command``) instead of Python in the worker (``open_reader``)."""
    server: ClassVar[bool] = False
    """A database server keeps its data on its own disk: the run's target doesn't apply."""

    def __init__(self, place: Place, namespace: str) -> None:
        self.place = place
        self.namespace = namespace

    @property
    def target(self) -> Target:
        """Where the tables live."""
        return self.place.target

    def reset(self) -> None:
        """Removes what an earlier run left."""
        self.place.clear()

    @abstractmethod
    def create(self, spec: TableSpec, schema: pa.Schema) -> None:
        """Creates an empty table; time-series tables are partitioned by time where the system supports it."""

    @abstractmethod
    def append(self, table: str, data: pa.Table) -> None:
        """Commits one batch."""

    @abstractmethod
    def maintain(self) -> None:
        """The system's standard maintenance (compaction and cleanup)."""

    @abstractmethod
    def state(self) -> dict[str, Any]:
        """What the readers need to find the tables; saved after each phase."""

    def stats(self) -> StorageStats:
        """Objects and bytes the tables take."""
        return self.place.storage_stats()

    @classmethod
    @abstractmethod
    def version(cls) -> dict[str, str]:
        """Versions of the packages the system and its readers use (name -> version)."""

    def ingest_extras(self) -> IngestRecord:
        """System-specific fields of the ingest record."""
        return {}

    def maintain_extras(self) -> IngestRecord:
        """System-specific fields of the maintenance record."""
        return {}

    @classmethod
    def open_reader(cls, reader: str, place: Place, state: dict[str, Any]) -> Runner:
        """Opens a reader in the worker process (readers that run in Python)."""
        msg = f"{cls.name} has no Python reader {reader}"
        raise NotImplementedError(msg)

    @classmethod
    def reader_command(cls, reader: str, place: Place, state: dict[str, Any], runs: int) -> list[str]:
        """The command of a reader in ``commands``; it reads the SQL on stdin and prints the record fields."""
        msg = f"{cls.name} has no reader binary {reader}"
        raise NotImplementedError(msg)


def duckdb_connection(target: Target) -> Any:  # noqa: ANN401 (duckdb is imported lazily)
    """A DuckDB connection in UTC, with S3 access through the counting proxy when the target is S3."""
    import duckdb

    from timebench.s3 import PROXY

    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")  # bucket by UTC days like the other engines (and avoid ICU calendar math)
    if target.s3:
        con.execute("INSTALL httpfs; LOAD httpfs")
        con.execute(PROXY.duckdb_secret())
    return con


def duckdb_runner(con: Any) -> Runner:  # noqa: ANN401
    """A runner over a DuckDB connection."""
    return lambda sql: con.execute(sql).fetch_arrow_table().num_rows


def systems() -> dict[str, type[System]]:
    """All systems by name."""
    from timebench.systems.iceberg import Iceberg, S3Tables
    from timebench.systems.lance import Lance
    from timebench.systems.parquet import ParquetFiles
    from timebench.systems.timelake import Timelake
    from timebench.systems.timescaledb import TimescaleDB

    return {s.name: s for s in (Timelake, Iceberg, S3Tables, Lance, ParquetFiles, TimescaleDB)}
