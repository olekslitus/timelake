"""Live size of each system's tables: data files referenced by the current version only
(excludes files kept for time travel / not yet cleaned up). Appends to results/v0_ingest.jsonl.

    python v0/live_size.py local maintained
"""

import sys

sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
from common import LANCE_S3, OBJECT_STORE_S3, PYICEBERG_S3, load_state, local_dir, record, root  # noqa: E402


def iceberg(storage, tables):
    from pyiceberg.catalog.sql import SqlCatalog

    d = local_dir(storage, "iceberg")
    cat = SqlCatalog("v0", uri=f"sqlite:///{d}/catalog.db",
                     warehouse=root(storage, "iceberg") if storage == "s3" else f"file://{root(storage, 'iceberg')}",
                     **(PYICEBERG_S3 if storage == "s3" else {}))
    files = bytes_ = 0
    for t in ("readings", "diagnostics"):
        for task in cat.load_table(f"tsbs.{t}").scan().plan_files():
            files += 1
            bytes_ += task.file.file_size_in_bytes
    return files, bytes_


def lance(storage, tables):
    import lance as l

    files = bytes_ = 0
    for t in ("readings", "diagnostics"):
        ds = l.dataset(tables[t], storage_options=LANCE_S3 if storage == "s3" else None)
        for f in ds.get_fragments():
            for df in f.data_files():
                files += 1
                bytes_ += df.file_size_bytes or 0
    return files, bytes_


def timelake(storage, tables):
    import timelake as tl

    lake = tl.Lake(tables["root"], storage_options=OBJECT_STORE_S3 if storage == "s3" else None)
    files = bytes_ = 0
    for t in ("readings", "diagnostics"):
        i = lake.table(f"tsbs.{t}").info()
        files += i["files"]
        bytes_ += i["bytes"]
    return files, bytes_


def main(storage, phase):
    for name, fn in (("iceberg", iceberg), ("lance", lance), ("timelake", timelake)):
        files, b = fn(storage, load_state(storage, name)["tables"])
        rec = {"system": name, "storage": storage, "phase": f"live-{phase}", "live_files": files, "live_bytes": b}
        record(rec)
        print(rec)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
