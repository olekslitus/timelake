"""Naive Iceberg (PyIceberg appends, the S3 Tables / Firehose write pattern) and real S3 Tables; read by DuckDB."""

from __future__ import annotations

import datetime as dt
import os
import time
from functools import cached_property
from typing import TYPE_CHECKING, Any, override

from benchlib.meta import version
from benchlib.s3 import PROXY
from benchlib.systems import Runner, System, duckdb_connection, duckdb_runner

if TYPE_CHECKING:
    import pyarrow as pa
    from pyiceberg.catalog import Catalog
    from pyiceberg.table import Table as IcebergTable

    from benchlib.results import IngestRecord
    from benchlib.targets import Place, StorageStats
    from benchlib.workloads import TableSpec


class Iceberg(System):
    """PyIceberg appends into a SQLite-catalog warehouse, time-series tables partitioned by ``day(time)``.

    Maintenance is binpack compaction (S3 Tables' default: same rows, bigger files, no re-sort), simulated by
    rewriting each time-series table.
    """

    name = "iceberg"
    title = "Iceberg (PyIceberg)"
    readers = ("duckdb",)

    def __init__(self, place: Place, namespace: str) -> None:
        super().__init__(place, namespace)
        self.tables: dict[str, IcebergTable] = {}
        self.time_series: list[str] = []

    @cached_property
    def catalog(self) -> Catalog:
        """The catalog, opened on first use (after ``reset`` has cleared the local directory)."""
        from pyiceberg.catalog.sql import SqlCatalog

        root = self.place.root
        return SqlCatalog(
            "bench",
            uri=f"sqlite:///{self.place.local_dir}/catalog.db",
            warehouse=root if self.target.s3 else f"file://{root}",
            **(PROXY.pyiceberg_properties() if self.target.s3 else {}),
        )

    @override
    def create(self, spec: TableSpec, schema: pa.Schema) -> None:
        from pyiceberg.transforms import DayTransform

        self.catalog.create_namespace_if_not_exists(self.namespace)
        name = f"{self.namespace}.{spec.name}"
        table = self.catalog.create_table(name, schema=schema)
        if spec.time_column:
            with table.update_spec() as update:
                update.add_field(spec.time_column, DayTransform(), f"{spec.time_column}_day")
            table = self.catalog.load_table(name)
            self.time_series.append(spec.name)
        self.tables[spec.name] = table

    @override
    def append(self, table: str, data: pa.Table) -> None:
        self.tables[table].append(data)

    @override
    def maintain(self) -> None:
        for name in self.time_series or self.loaded_time_series():
            table = self.catalog.load_table(f"{self.namespace}.{name}")
            table.overwrite(table.scan().to_arrow())

    def loaded_time_series(self) -> list[str]:
        """The partitioned tables of an earlier process (``maintain`` without ``create``)."""
        names = [t for _, t in self.catalog.list_tables(self.namespace)]
        return [n for n in names if self.catalog.load_table(f"{self.namespace}.{n}").spec().fields]

    @override
    def state(self) -> dict[str, Any]:
        names = [t for _, t in self.catalog.list_tables(self.namespace)]
        return {"tables": {n: self.catalog.load_table(f"{self.namespace}.{n}").metadata_location for n in names}}

    @override
    @classmethod
    def version(cls) -> dict[str, str]:
        return {"pyiceberg": version("pyiceberg") or "?", "duckdb": version("duckdb") or "?"}

    @override
    @classmethod
    def open_reader(cls, reader: str, place: Place, state: dict[str, Any]) -> Runner:
        con = duckdb_connection(place.target)
        con.execute("INSTALL iceberg; LOAD iceberg")
        for t, metadata in state["tables"].items():
            con.execute(f"CREATE VIEW {t} AS SELECT * FROM iceberg_scan('{metadata}')")
        return duckdb_runner(con)


class S3Tables(Iceberg):
    """Real S3 Tables: the same appends committed through its Iceberg REST endpoint, and its own managed compaction.

    AWS targets only, with ``BENCH_TABLE_BUCKET_ARN`` set. Maintenance waits (up to ``BENCH_S3TABLES_WAIT_S``, 6 h by
    default) until S3 Tables has compacted every time-series table after ingest.
    """

    name = "s3tables"
    title = "S3 Tables (PyIceberg)"
    poll_seconds = 120

    def __init__(self, place: Place, namespace: str) -> None:
        import boto3

        if not place.target.s3:
            msg = "S3 Tables runs on AWS targets only"
            raise SystemExit(msg)
        super().__init__(place, namespace)
        self.region = os.environ["AWS_REGION"]
        self.arn = os.environ["BENCH_TABLE_BUCKET_ARN"]
        self.wait_s = int(os.environ.get("BENCH_S3TABLES_WAIT_S", str(6 * 3600)))
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
        if not self.catalog.namespace_exists(self.namespace):
            return
        for _, name in self.catalog.list_tables(self.namespace):
            self.client.delete_table(tableBucketARN=self.arn, namespace=self.namespace, name=name)

    @override
    def stats(self) -> StorageStats:
        """Table buckets can't be listed, so count from Iceberg metadata: live data files, plus manifests."""
        data_files = data_bytes = manifests = 0
        for _, name in self.catalog.list_tables(self.namespace):
            table = self.catalog.load_table(f"{self.namespace}.{name}")
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
        since = dt.datetime.fromisoformat(self.place.load_state()["ingested_at"])
        names = self.time_series or self.loaded_time_series()
        deadline = time.time() + self.wait_s
        while time.time() < deadline:
            for n in names:
                job = self.client.get_table_maintenance_job_status(
                    tableBucketARN=self.arn, namespace=self.namespace, name=n
                )
                compaction: dict[str, Any] = job["status"].get("icebergCompaction", {})
                ran = compaction.get("lastRunTimestamp")
                if ran and ran > since and compaction.get("status") == "Successful":
                    self.compaction[n] = round((ran - since).total_seconds())
            print(f"  waiting for S3 Tables compaction: {self.compaction or 'not yet'}", flush=True)
            if len(self.compaction) == len(names):
                return
            time.sleep(self.poll_seconds)
        print("  compaction did not run before the deadline", flush=True)

    @override
    def maintain_extras(self) -> IngestRecord:
        return {"compaction_after_ingest_s": self.compaction}
