"""Write the TSBS IoT Parquet tables as Iceberg tables (plain-lake baseline, SPEC §17.3).

Layout: readings/diagnostics partitioned by day(time) and sorted by (tags_id, time). This is the
layout a team would get from S3 Tables + a sort-compaction Glue job. Writes data/tsbs/iceberg[-s3]/metadata.json
mapping table -> current metadata file, for DuckDB's iceberg_scan.

    python tsbs_to_iceberg.py        # local filesystem warehouse
    python tsbs_to_iceberg.py s3     # s3://bench/tsbs/iceberg on the local RustFS (bench README)
"""

import json
import os
import shutil
import sys
from pathlib import Path

import pyarrow.parquet as pq
from pyiceberg.catalog.sql import SqlCatalog
from pyiceberg.transforms import DayTransform, IdentityTransform

DATA = Path(__file__).resolve().parent.parent / "data" / "tsbs"
S3_PROPS = {
    "s3.endpoint": "http://localhost:59000",
    "s3.access-key-id": "benchkey",
    "s3.secret-access-key": "benchsecret123",
    "s3.region": "us-east-1",
}


def main(target: str):
    # BENCH_ICEBERG_S3_DIR keeps catalogs for different S3 targets apart (e.g. RustFS vs AWS).
    out = DATA / (os.environ.get("BENCH_ICEBERG_S3_DIR", "iceberg-s3") if target == "s3" else "iceberg")
    shutil.rmtree(out, ignore_errors=True)
    (out / "warehouse").mkdir(parents=True)
    warehouse = "s3://bench/tsbs/iceberg" if target == "s3" else f"file://{out}/warehouse"
    catalog = SqlCatalog(
        "bench",
        uri=f"sqlite:///{out}/catalog.db",
        warehouse=warehouse,
        **(S3_PROPS if target == "s3" else {}),
    )
    catalog.create_namespace("tsbs")
    locations = {}
    for name in ["tags", "readings", "diagnostics"]:
        table = pq.read_table(DATA / "parquet" / f"{name}.parquet")
        if name == "tags":
            ice = catalog.create_table(f"tsbs.{name}", schema=table.schema)
        else:
            table = table.sort_by([("tags_id", "ascending"), ("time", "ascending")])
            ice = catalog.create_table(f"tsbs.{name}", schema=table.schema)
            with ice.update_spec() as spec:
                spec.add_field("time", DayTransform(), "time_day")
            ice = catalog.load_table(f"tsbs.{name}")
            with ice.transaction() as tx:
                tx.update_sort_order().asc("tags_id", IdentityTransform()).asc("time", IdentityTransform()).commit()
        ice.append(table)
        ice = catalog.load_table(f"tsbs.{name}")
        locations[name] = ice.metadata_location
        files = list(ice.scan().plan_files())
        print(f"{name}: {table.num_rows} rows, {len(files)} data files")
    (out / "metadata.json").write_text(json.dumps(locations, indent=2))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "local")
