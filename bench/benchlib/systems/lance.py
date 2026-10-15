"""Lance: ``write_dataset(mode="append")`` per commit; read by DuckDB and by DataFusion with Lance's scanner."""

from __future__ import annotations

import datetime as dt
import os
from typing import TYPE_CHECKING, Any, override

from benchlib.meta import version
from benchlib.s3 import PROXY, SETUP_PROXY
from benchlib.systems import Runner, System, duckdb_connection, duckdb_runner

if TYPE_CHECKING:
    import pyarrow as pa

    from benchlib.targets import Place
    from benchlib.workloads import TableSpec


class Lance(System):
    """One Lance dataset per table. Maintenance is ``compact_files()`` and ``cleanup_old_versions()``."""

    name = "lance"
    title = "Lance"
    readers = ("duckdb", "datafusion")

    def __init__(self, place: Place, namespace: str) -> None:
        super().__init__(place, namespace)
        self.options = PROXY.lance_options() if place.target.s3 else None
        self.created: set[str] = set()

    def uri(self, table: str) -> str:
        """Where a table's dataset lives."""
        return f"{self.place.root}/{table}.lance"

    @override
    def create(self, spec: TableSpec, schema: pa.Schema) -> None:
        """Lance creates a dataset on its first write."""

    @override
    def append(self, table: str, data: pa.Table) -> None:
        import lance

        mode = "append" if table in self.created else "create"
        lance.write_dataset(data, self.uri(table), mode=mode, storage_options=self.options)
        self.created.add(table)

    @override
    def maintain(self) -> None:
        import lance

        options = self.options
        if options and os.environ.get("BENCH_LANCE_DIRECT"):
            # Lance's multipart uploads fail through tools/s3proxy on RustFS; compact directly against it.
            options = SETUP_PROXY.lance_options()
        for table in self.place.load_state()["tables"]:
            lance.dataset(self.uri(table), storage_options=options).optimize.compact_files()
            lance.dataset(self.uri(table), storage_options=options).cleanup_old_versions(older_than=dt.timedelta(0))

    @override
    def state(self) -> dict[str, Any]:
        tables = self.created or set(self.place.load_state()["tables"])
        return {"tables": {t: self.uri(t) for t in sorted(tables)}}

    @override
    @classmethod
    def version(cls) -> dict[str, str]:
        return {
            "pylance": version("pylance") or "?",
            "duckdb": version("duckdb") or "?",
            "datafusion": version("datafusion") or "?",
        }

    @override
    @classmethod
    def open_reader(cls, reader: str, place: Place, state: dict[str, Any]) -> Runner:
        import lance

        options = PROXY.lance_options() if place.target.s3 else None
        datasets = {t: lance.dataset(uri, storage_options=options) for t, uri in state["tables"].items()}
        if reader == "duckdb":
            con = duckdb_connection(place.target)
            for t, ds in datasets.items():
                con.register(t, ds)
            return duckdb_runner(con)

        from datafusion import SessionContext

        ctx = SessionContext()
        for t, ds in datasets.items():
            ctx.register_table(t, lance.FFILanceTableProvider(ds))
        return lambda sql: ctx.sql(sql).to_arrow_table().num_rows
