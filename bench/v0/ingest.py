"""Stream the TSBS IoT tables into one system as Firehose-style micro-batches, then (optionally)
run that system's standard maintenance.

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
"""

import argparse
import os
import shutil
import statistics
import sys
import time
from datetime import datetime, timezone

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
from common import (
    DATA,
    LANCE_S3,
    OBJECT_STORE_S3,
    PYICEBERG_S3,
    TABLES,
    load_state,
    local_dir,
    record,
    root,
    save_state,
    storage_stats,
)


def windows(table: pa.Table, minutes: int) -> list[pa.Table]:
    """Split by time window (the table is in generation order, i.e. by time)."""
    us = pc.cast(table["time"], pa.int64()).to_numpy()
    w = us // (minutes * 60_000_000)
    order = np.argsort(w, kind="stable")
    table, w = table.take(order), w[order]
    cuts = np.flatnonzero(np.diff(w)) + 1
    bounds = [0, *cuts.tolist(), len(w)]
    return [table.slice(a, b - a) for a, b in zip(bounds, bounds[1:])]


class Iceberg:
    def __init__(self, storage):
        from pyiceberg.catalog.sql import SqlCatalog

        d = local_dir(storage, "iceberg")
        self.catalog = SqlCatalog(
            "v0",
            uri=f"sqlite:///{d}/catalog.db",
            warehouse=root(storage, "iceberg") if storage == "s3" else f"file://{root(storage, 'iceberg')}",
            **(PYICEBERG_S3 if storage == "s3" else {}),
        )
        self.tables = {}

    def create(self, name, schema, time_series):
        from pyiceberg.transforms import DayTransform

        self.catalog.create_namespace_if_not_exists("tsbs")
        t = self.catalog.create_table(f"tsbs.{name}", schema=schema)
        if time_series:
            with t.update_spec() as spec:
                spec.add_field("time", DayTransform(), "time_day")
            t = self.catalog.load_table(f"tsbs.{name}")
        self.tables[name] = t

    def append(self, name, data):
        self.tables[name].append(data)

    def state(self):
        return {n: self.catalog.load_table(f"tsbs.{n}").metadata_location for n in TABLES}

    def maintain(self):
        # S3 Tables' managed compaction is binpack by default: same rows, bigger files, no re-sort.
        for n in ("readings", "diagnostics"):
            t = self.catalog.load_table(f"tsbs.{n}")
            data = t.scan().to_arrow()
            t.overwrite(data)


class S3Tables(Iceberg):
    def __init__(self, storage):
        import boto3
        from pyiceberg.catalog.rest import RestCatalog

        assert storage == "s3", "S3 Tables runs on AWS only"
        region = os.environ["AWS_REGION"]
        self.arn = os.environ["BENCH_TABLE_BUCKET_ARN"]
        self.client = boto3.client("s3tables", region_name=region)
        self.catalog = RestCatalog(
            "s3tables",
            uri=f"https://s3tables.{region}.amazonaws.com/iceberg",
            warehouse=self.arn,
            **{"rest.sigv4-enabled": "true", "rest.signing-name": "s3tables", "rest.signing-region": region},
            **PYICEBERG_S3,  # data and metadata files through the counting proxy, which passes them to the table's bucket
        )
        self.tables = {}

    def reset(self):
        for n in TABLES:
            if self.catalog.table_exists(f"tsbs.{n}"):
                self.client.delete_table(tableBucketARN=self.arn, namespace="tsbs", name=n)

    def stats(self) -> dict:
        """Table buckets can't be listed, so count from Iceberg metadata: live data files, plus manifests."""
        data_files = data_bytes = manifests = 0
        for n in TABLES:
            t = self.catalog.load_table(f"tsbs.{n}")
            files = t.inspect.files()
            data_files += files.num_rows
            data_bytes += sum(files["file_size_in_bytes"].to_pylist())
            manifests += len(set(t.inspect.all_manifests()["path"].to_pylist()))  # listed once per snapshot
        return {
            "objects": data_files + manifests,
            "data_files": data_files,
            "data_bytes": data_bytes,
            "bytes": data_bytes,
        }

    def maintain(self):
        """Wait for S3 Tables' managed compaction to run on both time-series tables (up to V0_S3TABLES_WAIT_S)."""
        import datetime as dt

        since = dt.datetime.fromisoformat(load_state("s3", "s3tables")["ingested_at"])
        deadline = time.time() + int(os.environ.get("V0_S3TABLES_WAIT_S", 6 * 3600))
        self.compaction = {}
        while time.time() < deadline:
            for n in ("readings", "diagnostics"):
                job = self.client.get_table_maintenance_job_status(tableBucketARN=self.arn, namespace="tsbs", name=n)
                c = job["status"].get("icebergCompaction", {})
                ran = c.get("lastRunTimestamp")
                if ran and ran > since and c.get("status") == "Successful":
                    self.compaction[n] = round((ran - since).total_seconds())
            print(f"  waiting for compaction: {self.compaction or 'not yet'}", flush=True)
            if len(self.compaction) == 2:
                return
            time.sleep(120)
        print("  compaction did not run before the deadline", flush=True)


class Lance:
    def __init__(self, storage):
        self.storage = storage
        self.opts = LANCE_S3 if storage == "s3" else None
        self.base = root(storage, "lance")

    def uri(self, name):
        return f"{self.base}/{name}.lance"

    def create(self, name, schema, time_series):
        pass

    def append(self, name, data):
        import lance

        mode = "append" if getattr(self, f"_made_{name}", False) else "create"
        lance.write_dataset(data, self.uri(name), mode=mode, storage_options=self.opts)
        setattr(self, f"_made_{name}", True)

    def state(self):
        return {n: self.uri(n) for n in TABLES}

    def maintain(self):
        import datetime as dt

        import lance

        opts = self.opts
        if opts and os.environ.get("V0_LANCE_DIRECT"):
            # Lance's multipart uploads fail through tools/s3proxy; compact directly against RustFS.
            opts = {**opts, "aws_endpoint": "http://localhost:59000"}
        for n in ("readings", "diagnostics"):
            ds = lance.dataset(self.uri(n), storage_options=opts)
            ds.optimize.compact_files()
            ds = lance.dataset(self.uri(n), storage_options=opts)
            ds.cleanup_old_versions(older_than=dt.timedelta(0))


class Timelake:
    def __init__(self, storage):
        import timelake

        self.lake = timelake.Lake(
            root(storage, "timelake"), storage_options=OBJECT_STORE_S3 if storage == "s3" else None
        )
        self.tables = {}
        self.maint = 0

    def create(self, name, schema, time_series):
        kw = dict(time_column="time", series_key=["tags_id"], dedup=False) if time_series else {}
        self.tables[name] = self.lake.create_table(f"tsbs.{name}", schema, **kw)

    def append(self, name, data):
        r = self.tables[name].append(data)
        self.maint += r.get("maintenance", {}).get("partitions_compacted", 0) > 0

    def state(self):
        return {"root": self.lake.location, **{n: self.lake.table(f"tsbs.{n}").location for n in TABLES}}

    def maintain(self):
        for n in TABLES:
            print(n, self.lake.table(f"tsbs.{n}").maintain())


SYSTEMS = {"iceberg": Iceberg, "lance": Lance, "timelake": Timelake, "s3tables": S3Tables}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--system", required=True, choices=list(SYSTEMS))
    p.add_argument("--storage", default="local", choices=["local", "s3"])
    p.add_argument("--window-minutes", type=int, default=5)
    p.add_argument("--max-windows", type=int, default=0, help="stop early (smoke tests)")
    p.add_argument("--maintain-only", action="store_true")
    a = p.parse_args()

    if not a.maintain_only:
        shutil.rmtree(local_dir(a.storage, a.system), ignore_errors=True)
        (local_dir(a.storage, a.system) / "lake").mkdir(parents=True)
        if a.storage == "s3":
            import pyarrow.fs as pafs
            from common import S3

            fs = pafs.S3FileSystem(
                access_key=S3["key"],
                secret_key=S3["secret"],
                region=S3["region"],
                endpoint_override="http://localhost:59000",
                scheme="http",
            )
            fs.delete_dir_contents(f"bench/v0/{a.system}", missing_dir_ok=True)
        sys_ = SYSTEMS[a.system](a.storage)
        if hasattr(sys_, "reset"):
            sys_.reset()
        src = {n: pq.read_table(DATA / "tsbs" / "parquet" / f"{n}.parquet") for n in TABLES}
        for n in TABLES:
            sys_.create(n, src[n].schema, n != "tags")
        sys_.append("tags", src["tags"])
        r_w, d_w = windows(src["readings"], a.window_minutes), windows(src["diagnostics"], a.window_minutes)
        if a.max_windows:
            r_w, d_w = r_w[: a.max_windows], d_w[: a.max_windows]
        lat = []
        t0 = time.perf_counter()
        for i, (r, d) in enumerate(zip(r_w, d_w)):
            for name, batch in (("readings", r), ("diagnostics", d)):
                t = time.perf_counter()
                sys_.append(name, batch)
                lat.append(time.perf_counter() - t)
            if i % 100 == 0:
                print(
                    f"  window {i}/{len(r_w)}  {time.perf_counter() - t0:.1f}s  last commit {lat[-1] * 1000:.0f} ms",
                    flush=True,
                )
        total = time.perf_counter() - t0
        rows = sum(b.num_rows for b in r_w) + sum(b.num_rows for b in d_w)
        save_state(
            a.storage,
            a.system,
            {"tables": sys_.state(), "phase": "ingested", "ingested_at": datetime.now(timezone.utc).isoformat()},
        )
        rec = {
            "system": a.system,
            "storage": a.storage,
            "phase": "ingest",
            "window_minutes": a.window_minutes,
            "commits": len(lat),
            "rows": rows,
            "seconds": round(total, 2),
            "commit_ms_p50": round(statistics.median(lat) * 1000, 1),
            "commit_ms_p95": round(float(np.percentile(lat, 95)) * 1000, 1),
            "commit_ms_max": round(max(lat) * 1000, 1),
            **(sys_.stats() if hasattr(sys_, "stats") else storage_stats(a.storage, a.system)),
        }
        if a.system == "timelake":
            rec["inline_compactions"] = sys_.maint
        record(rec)
        print(rec)
    else:
        sys_ = SYSTEMS[a.system](a.storage)
        if a.system == "iceberg":
            from pyiceberg.catalog.sql import SqlCatalog  # noqa: F401
        t0 = time.perf_counter()
        sys_.maintain()
        state = load_state(a.storage, a.system)
        state.update(tables=sys_.state(), phase="maintained")
        save_state(a.storage, a.system, state)
        rec = {
            "system": a.system,
            "storage": a.storage,
            "phase": "maintain",
            "seconds": round(time.perf_counter() - t0, 2),
            **(sys_.stats() if hasattr(sys_, "stats") else storage_stats(a.storage, a.system)),
        }
        if getattr(sys_, "compaction", None) is not None:
            rec["compaction_after_ingest_s"] = sys_.compaction
        record(rec)
        print(rec)


if __name__ == "__main__":
    main()
