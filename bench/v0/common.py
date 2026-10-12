"""Shared settings for the v0 benchmark (SPEC §19.0): where each system's tables live."""

import json
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
DATA = BENCH / "data"
RESULTS = BENCH / "results"
SYSTEMS = ["iceberg", "lance", "timelake"]
TABLES = ["tags", "readings", "diagnostics"]

S3 = {"endpoint": "localhost:59100", "admin": "http://localhost:59101", "key": "benchkey", "secret": "benchsecret123", "region": "us-east-1"}
PYICEBERG_S3 = {
    "s3.endpoint": f"http://{S3['endpoint']}",
    "s3.access-key-id": S3["key"],
    "s3.secret-access-key": S3["secret"],
    "s3.region": S3["region"],
}
OBJECT_STORE_S3 = {  # Rust object_store keys (Lance, Timelake)
    "aws_endpoint": f"http://{S3['endpoint']}",
    "aws_access_key_id": S3["key"],
    "aws_secret_access_key": S3["secret"],
    "aws_region": S3["region"],
    "aws_allow_http": "true",
}
LANCE_S3 = {
    "aws_endpoint": f"http://{S3['endpoint']}",
    "aws_access_key_id": S3["key"],
    "aws_secret_access_key": S3["secret"],
    "aws_region": S3["region"],
    "allow_http": "true",
}


def local_dir(storage: str, system: str) -> Path:
    return DATA / "v0" / storage / system


def root(storage: str, system: str) -> str:
    return f"s3://bench/v0/{system}" if storage == "s3" else str(local_dir(storage, system) / "lake")


def state_path(storage: str, system: str) -> Path:
    return local_dir(storage, system) / "state.json"


def load_state(storage: str, system: str) -> dict:
    return json.loads(state_path(storage, system).read_text())


def save_state(storage: str, system: str, state: dict):
    p = state_path(storage, system)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(state, indent=2))


def record(rec: dict):
    RESULTS.mkdir(exist_ok=True)
    with (RESULTS / "v0_ingest.jsonl").open("a") as f:
        f.write(json.dumps(rec) + "\n")


def storage_stats(storage: str, system: str) -> dict:
    """Objects and bytes under a system's root (all files: data + metadata)."""
    import pyarrow.fs as pafs

    if storage == "s3":
        fs = pafs.S3FileSystem(
            access_key=S3["key"], secret_key=S3["secret"], region=S3["region"],
            endpoint_override=f"http://localhost:59000", scheme="http",
        )
        base = f"bench/v0/{system}"
    else:
        fs, base = pafs.LocalFileSystem(), root(storage, system)
    infos = fs.get_file_info(pafs.FileSelector(base, recursive=True, allow_not_found=True))
    files = [i for i in infos if i.type == pafs.FileType.File]
    data = [i for i in files if i.path.endswith((".parquet", ".lance")) and "/metadata/" not in i.path]
    return {
        "objects": len(files),
        "bytes": sum(i.size for i in files),
        "data_files": len(data),
        "data_bytes": sum(i.size for i in data),
    }
