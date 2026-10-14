"""Stream the TSBS IoT tables into one system as Firehose-style micro-batches, then run its maintenance.

    python v0/ingest.py --system timelake --storage local
    python v0/ingest.py --system iceberg --storage s3 --maintain-only

Systems, each used the way its docs suggest for this workload:
  iceberg   PyIceberg appends into a day-partitioned table (the S3 Tables / Firehose write pattern).
            Maintenance = binpack compaction (S3 Tables' default), simulated by rewriting each table.
  lance     lance.write_dataset(mode="append"). Maintenance = compact_files + cleanup_old_versions.
  timelake  Table.append (inline auto-maintenance on). Maintenance = Table.maintain().
  s3tables  Real S3 Tables (AWS, --storage s3, BENCH_TABLE_BUCKET_ARN): the iceberg system's appends, committed
            through the S3 Tables Iceberg REST endpoint. Maintenance = S3 Tables' own managed compaction, which
            runs asynchronously: --maintain-only waits until it has run on both time-series tables.
Every system gets identical rows (Timelake dedup is off so TSBS's 16 duplicate rows stay).

Environment: BENCH_S3_NAME names the S3 target, V0_INGEST_LOG the results file, V0_S3TABLES_WAIT_S how long to
wait for S3 Tables' compaction, V0_LANCE_DIRECT=1 compacts Lance without the proxy.
"""

from __future__ import annotations

import argparse
import datetime as dt
import itertools
import os
import shutil
import statistics
import time
from abc import ABC, abstractmethod
from functools import cached_property
from typing import TYPE_CHECKING, Any, override

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from benchlib import DATA, TSBS_TABLES, TSBS_TIME_SERIES
from benchlib.s3 import BUCKET, PROXY, SETUP_PROXY
from benchlib.v0 import StorageStats, Target

if TYPE_CHECKING:
    from pyiceberg.catalog import Catalog
    from pyiceberg.table import Table as IcebergTable

    import timelake
    from benchlib.results import IngestRecord


def windows(table: pa.Table, minutes: int) -> list[pa.Table]:
    """Splits a table by time window (the table is in generation order, i.e. by time)."""
    us = pc.cast(table["time"], pa.int64()).to_numpy()
    w = us // (minutes * 60_000_000)
    order = np.argsort(w, kind="stable")
    table, w = table.take(order), w[order]
    cuts = np.flatnonzero(np.diff(w)) + 1
    bounds = [0, *cuts.tolist(), len(w)]
    return [table.slice(a, b - a) for a, b in itertools.pairwise(bounds)]


class System(ABC):
    """One table format or service under test, used the way its docs suggest."""

    name: str

    def __init__(self, target: Target) -> None:
        self.target = target

    def reset(self) -> None:
        """Removes what an earlier run left: local state and, on S3, the system's objects."""
        local = self.target.local_dir(self.name)
        shutil.rmtree(local, ignore_errors=True)
        (local / "lake").mkdir(parents=True)
        if self.target.storage == "s3":
            SETUP_PROXY.pyarrow_fs().delete_dir_contents(f"{BUCKET}/v0/{self.name}", missing_dir_ok=True)

    @abstractmethod
    def create(self, name: str, schema: pa.Schema, *, time_series: bool) -> None:
        """Creates an empty table; time-series tables are partitioned by time where the system supports it."""

    @abstractmethod
    def append(self, name: str, data: pa.Table) -> None:
        """Commits one micro-batch."""

    @abstractmethod
    def state(self) -> dict[str, str]:
        """Where the readers find each table (for ``run.py``)."""

    @abstractmethod
    def maintain(self) -> None:
        """The system's standard maintenance."""

    def stats(self) -> StorageStats:
        """Objects and bytes the tables take."""
        return self.target.storage_stats(self.name)

    def ingest_extras(self) -> IngestRecord:
        """System-specific fields of the ingest record."""
        return {}

    def maintain_extras(self) -> IngestRecord:
        """System-specific fields of the maintenance record."""
        return {}


class Iceberg(System):
    """PyIceberg appends into a SQLite-catalog warehouse."""

    name = "iceberg"

    def __init__(self, target: Target) -> None:
        super().__init__(target)
        self.tables: dict[str, IcebergTable] = {}

    @cached_property
    def catalog(self) -> Catalog:
        """The catalog, opened on first use (after ``reset`` has cleared the local directory)."""
        from pyiceberg.catalog.sql import SqlCatalog

        root = self.target.root(self.name)
        return SqlCatalog(
            "v0",
            uri=f"sqlite:///{self.target.local_dir(self.name)}/catalog.db",
            warehouse=root if self.target.storage == "s3" else f"file://{root}",
            **(PROXY.pyiceberg_properties() if self.target.storage == "s3" else {}),
        )

    @override
    def create(self, name: str, schema: pa.Schema, *, time_series: bool) -> None:
        from pyiceberg.transforms import DayTransform

        catalog = self.catalog
        catalog.create_namespace_if_not_exists("tsbs")
        table = catalog.create_table(f"tsbs.{name}", schema=schema)
        if time_series:
            with table.update_spec() as spec:
                spec.add_field("time", DayTransform(), "time_day")
            table = catalog.load_table(f"tsbs.{name}")
        self.tables[name] = table

    @override
    def append(self, name: str, data: pa.Table) -> None:
        self.tables[name].append(data)

    @override
    def state(self) -> dict[str, str]:
        catalog = self.catalog
        return {n: catalog.load_table(f"tsbs.{n}").metadata_location for n in TSBS_TABLES}

    @override
    def maintain(self) -> None:
        # S3 Tables' managed compaction is binpack by default: same rows, bigger files, no re-sort.
        catalog = self.catalog
        for n in TSBS_TIME_SERIES:
            table = catalog.load_table(f"tsbs.{n}")
            table.overwrite(table.scan().to_arrow())


class S3Tables(Iceberg):
    """Real S3 Tables: Iceberg REST commits, and S3 Tables' own managed compaction."""

    name = "s3tables"
    poll_seconds = 120

    def __init__(self, target: Target) -> None:
        import boto3

        if target.storage != "s3":
            msg = "S3 Tables runs on AWS only (--storage s3)"
            raise SystemExit(msg)
        super().__init__(target)
        self.region = os.environ["AWS_REGION"]
        self.arn = os.environ["BENCH_TABLE_BUCKET_ARN"]
        self.wait_s = int(os.environ.get("V0_S3TABLES_WAIT_S", str(6 * 3600)))
        self.client = boto3.client("s3tables", region_name=self.region)
        self.compaction: dict[str, int] = {}

    @override
    @cached_property
    def catalog(self) -> Catalog:
        from pyiceberg.catalog.rest import RestCatalog

        return RestCatalog(
            "s3tables",
            uri=f"https://s3tables.{self.region}.amazonaws.com/iceberg",
            warehouse=self.arn,
            **{"rest.sigv4-enabled": "true", "rest.signing-name": "s3tables", "rest.signing-region": self.region},
            # Data and metadata files go through the counting proxy, which passes them to the table's bucket.
            **PROXY.pyiceberg_properties(),
        )

    @override
    def reset(self) -> None:
        super().reset()
        for n in TSBS_TABLES:
            if self.catalog.table_exists(f"tsbs.{n}"):
                self.client.delete_table(tableBucketARN=self.arn, namespace="tsbs", name=n)

    @override
    def stats(self) -> StorageStats:
        """Table buckets can't be listed, so count from Iceberg metadata: live data files, plus manifests."""
        data_files = data_bytes = manifests = 0
        for n in TSBS_TABLES:
            table = self.catalog.load_table(f"tsbs.{n}")
            files = table.inspect.files()
            data_files += files.num_rows
            data_bytes += sum(files["file_size_in_bytes"].to_pylist())
            manifests += len(set(table.inspect.all_manifests()["path"].to_pylist()))  # listed once per snapshot
        return {
            "objects": data_files + manifests,
            "data_files": data_files,
            "data_bytes": data_bytes,
            "bytes": data_bytes,
        }

    @override
    def maintain(self) -> None:
        """Waits for S3 Tables' managed compaction to run on both time-series tables (up to V0_S3TABLES_WAIT_S)."""
        since = dt.datetime.fromisoformat(self.target.load_state(self.name)["ingested_at"])
        deadline = time.time() + self.wait_s
        while time.time() < deadline:
            for n in TSBS_TIME_SERIES:
                job = self.client.get_table_maintenance_job_status(tableBucketARN=self.arn, namespace="tsbs", name=n)
                compaction: dict[str, Any] = job["status"].get("icebergCompaction", {})
                ran = compaction.get("lastRunTimestamp")
                if ran and ran > since and compaction.get("status") == "Successful":
                    self.compaction[n] = round((ran - since).total_seconds())
            print(f"  waiting for compaction: {self.compaction or 'not yet'}", flush=True)
            if len(self.compaction) == len(TSBS_TIME_SERIES):
                return
            time.sleep(self.poll_seconds)
        print("  compaction did not run before the deadline", flush=True)

    @override
    def maintain_extras(self) -> IngestRecord:
        return {"compaction_after_ingest_s": self.compaction}


class Lance(System):
    """Lance datasets, one per table."""

    name = "lance"

    def __init__(self, target: Target) -> None:
        super().__init__(target)
        self.options = PROXY.lance_options() if target.storage == "s3" else None
        self.created: set[str] = set()

    def uri(self, name: str) -> str:
        """Where a table's dataset lives."""
        return f"{self.target.root(self.name)}/{name}.lance"

    @override
    def create(self, name: str, schema: pa.Schema, *, time_series: bool) -> None:
        """Lance creates a dataset on its first write."""

    @override
    def append(self, name: str, data: pa.Table) -> None:
        import lance

        mode = "append" if name in self.created else "create"
        lance.write_dataset(data, self.uri(name), mode=mode, storage_options=self.options)
        self.created.add(name)

    @override
    def state(self) -> dict[str, str]:
        return {n: self.uri(n) for n in TSBS_TABLES}

    @override
    def maintain(self) -> None:
        import lance

        options = self.options
        if options and os.environ.get("V0_LANCE_DIRECT"):
            # Lance's multipart uploads fail through tools/s3proxy; compact directly against RustFS.
            options = SETUP_PROXY.lance_options()
        for n in TSBS_TIME_SERIES:
            lance.dataset(self.uri(n), storage_options=options).optimize.compact_files()
            lance.dataset(self.uri(n), storage_options=options).cleanup_old_versions(older_than=dt.timedelta(0))


class Timelake(System):
    """Timelake tables with inline auto-maintenance."""

    name = "timelake"

    def __init__(self, target: Target) -> None:
        import timelake

        super().__init__(target)
        options = PROXY.object_store_options() if target.storage == "s3" else None
        self.lake = timelake.Lake(target.root(self.name), storage_options=options)
        self.tables: dict[str, timelake.Table] = {}
        self.inline_compactions = 0

    @override
    def create(self, name: str, schema: pa.Schema, *, time_series: bool) -> None:
        if time_series:
            table = self.lake.create_table(
                f"tsbs.{name}", schema, time_column="time", series_key=["tags_id"], dedup=False
            )
        else:
            table = self.lake.create_table(f"tsbs.{name}", schema)
        self.tables[name] = table

    @override
    def append(self, name: str, data: pa.Table) -> None:
        maintenance = self.tables[name].append(data).get("maintenance")
        if maintenance and maintenance["partitions_compacted"] > 0:
            self.inline_compactions += 1

    @override
    def state(self) -> dict[str, str]:
        return {"root": self.lake.location, **{n: self.lake.table(f"tsbs.{n}").location for n in TSBS_TABLES}}

    @override
    def maintain(self) -> None:
        for n in TSBS_TABLES:
            print(n, self.lake.table(f"tsbs.{n}").maintain())

    @override
    def ingest_extras(self) -> IngestRecord:
        return {"inline_compactions": self.inline_compactions}


SYSTEMS: dict[str, type[System]] = {"iceberg": Iceberg, "lance": Lance, "timelake": Timelake, "s3tables": S3Tables}


def ingest(system: System, window_minutes: int, max_windows: int) -> IngestRecord:
    """Creates the tables, appends ``tags`` once and every time window of the time-series tables."""
    system.reset()
    source = {n: pq.read_table(DATA / "tsbs" / "parquet" / f"{n}.parquet") for n in TSBS_TABLES}
    for n in TSBS_TABLES:
        system.create(n, source[n].schema, time_series=n in TSBS_TIME_SERIES)
    system.append("tags", source["tags"])
    readings, diagnostics = (windows(source[n], window_minutes) for n in TSBS_TIME_SERIES)
    if max_windows:
        readings, diagnostics = readings[:max_windows], diagnostics[:max_windows]
    latencies: list[float] = []
    start = time.perf_counter()
    for i, batches in enumerate(zip(readings, diagnostics, strict=False)):
        for name, batch in zip(TSBS_TIME_SERIES, batches, strict=True):
            t = time.perf_counter()
            system.append(name, batch)
            latencies.append(time.perf_counter() - t)
        if i % 100 == 0:
            elapsed = time.perf_counter() - start
            print(
                f"  window {i}/{len(readings)}  {elapsed:.1f}s  last commit {latencies[-1] * 1000:.0f} ms", flush=True
            )
    seconds = time.perf_counter() - start
    ingested_at = dt.datetime.now(dt.timezone.utc).isoformat()
    system.target.save_state(system.name, {"tables": system.state(), "phase": "ingested", "ingested_at": ingested_at})
    record: IngestRecord = {
        "system": system.name,
        "storage": system.target.storage,
        "phase": "ingest",
        "window_minutes": window_minutes,
        "commits": len(latencies),
        "rows": sum(b.num_rows for b in readings) + sum(b.num_rows for b in diagnostics),
        "seconds": round(seconds, 2),
        "commit_ms_p50": round(statistics.median(latencies) * 1000, 1),
        "commit_ms_p95": round(float(np.percentile(latencies, 95)) * 1000, 1),
        "commit_ms_max": round(max(latencies) * 1000, 1),
        **system.stats(),
    }
    return {**record, **system.ingest_extras()}


def maintain(system: System) -> IngestRecord:
    """Runs the system's maintenance on what ``ingest`` left."""
    start = time.perf_counter()
    system.maintain()
    seconds = time.perf_counter() - start
    state = system.target.load_state(system.name)
    state.update(tables=system.state(), phase="maintained")
    system.target.save_state(system.name, state)
    record: IngestRecord = {
        "system": system.name,
        "storage": system.target.storage,
        "phase": "maintain",
        "seconds": round(seconds, 2),
        **system.stats(),
    }
    return {**record, **system.maintain_extras()}


def main() -> None:
    """Ingests or maintains one system and logs the record."""
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--system", required=True, choices=list(SYSTEMS))
    p.add_argument("--storage", default="local", choices=["local", "s3"])
    p.add_argument("--window-minutes", type=int, default=5)
    p.add_argument("--max-windows", type=int, default=0, help="stop early (smoke tests)")
    p.add_argument("--maintain-only", action="store_true")
    args = p.parse_args()

    target = Target.from_env(args.storage)
    system = SYSTEMS[args.system](target)
    record = maintain(system) if args.maintain_only else ingest(system, args.window_minutes, args.max_windows)
    target.log(record)
    print(record)


if __name__ == "__main__":
    main()
