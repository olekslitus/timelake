"""Reader/layout experiments on S3 (RustFS + 20 ms): geomean first-run time of the TSBS IoT and
single-truck queries through the timelake CLI, for several warehouses and DataFusion settings.

    python v0/experiment.py build 1048576          # tables with 1M-row row groups at s3://bench/v0/exp-rg1048576
    python v0/experiment.py run s3://bench/v0/timelake "datafusion.execution.target_partitions=32"
"""

import json
import math
import subprocess
import sys
from pathlib import Path

import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))
from common import DATA, OBJECT_STORE_S3, S3  # noqa: E402

import run  # noqa: E402

BIN = Path(__file__).resolve().parents[2] / "target" / "release" / "timelake"


def build(rg_rows: int):
    import timelake

    root = f"s3://bench/v0/exp-rg{rg_rows}"
    lake = timelake.Lake(root, storage_options=OBJECT_STORE_S3)
    for t in lake.tables():
        lake.drop_table(t)
    for name in ("tags", "readings", "diagnostics"):
        data = pq.read_table(DATA / "tsbs" / "parquet" / f"{name}.parquet")
        kw = dict(time_column="time", series_key=["tags_id"], dedup=False) if name != "tags" else {}
        t = lake.create_table(f"tsbs.{name}", data.schema, properties={"timelake.row-group-rows": str(rg_rows)}, **kw)
        print(name, t.append(data))
    print(root)


def bench(root: str, settings: list[str]):
    run.STORAGE = "s3"
    opts = [x for k, v in OBJECT_STORE_S3.items() for x in ("-o", f"{k}={v}")]
    sets = [x for s in settings for x in ("--set", s)]
    out = {}
    for suite in ("tsbs_iot", "iot_point"):
        firsts, reqs = [], []
        for name, sql in run.load_queries(suite, "v0-timelake"):
            p = subprocess.run([str(BIN), "-w", root, *opts, "sql", "--namespace", "tsbs", *sets, "--bench-runs", "1",
                                "--proxy-admin", S3["admin"].removeprefix("http://")], input=sql, capture_output=True, text=True)
            r = json.loads(p.stdout.strip().splitlines()[-1])
            firsts.append(r["times"][0])
            reqs.append(r["requests"][0])
        gm = math.exp(sum(map(math.log, firsts)) / len(firsts))
        out[suite] = (round(gm, 3), sum(reqs))
    print(root, settings, out)


if __name__ == "__main__":
    if sys.argv[1] == "build":
        build(int(sys.argv[2]))
    else:
        bench(sys.argv[2], sys.argv[3:])
