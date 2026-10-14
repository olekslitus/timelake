"""Where the v0 benchmark (SPEC §19.0) keeps each system's tables, and the state ``v0/ingest.py`` leaves."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, TypedDict

from benchlib import DATA, RESULTS
from benchlib.results import IngestRecord, append_jsonl
from benchlib.s3 import BUCKET, SETUP_PROXY

if TYPE_CHECKING:
    from pathlib import Path

SYSTEMS = ("iceberg", "lance", "timelake", "s3tables")
STORAGES = ("local", "s3")


class StorageStats(TypedDict):
    """Objects and bytes under a system's root."""

    objects: int | None
    """None where storage can't be listed (S3 Tables)."""
    bytes: int
    data_files: int
    data_bytes: int


@dataclass(frozen=True)
class Target:
    """A storage target: ``local``, or S3 under a name that tells S3 targets apart (``s3``, ``s3x``, ``aws-s3``)."""

    storage: str
    """``local`` or ``s3``."""
    name: str

    @classmethod
    def from_env(cls, storage: str) -> Target:
        """The target of a run: for S3, named by ``BENCH_S3_NAME`` (default ``s3``)."""
        return cls(storage, os.environ.get("BENCH_S3_NAME", "s3") if storage == "s3" else storage)

    def local_dir(self, system: str) -> Path:
        """Local files of a system: its state, catalogs, and its tables when storage is local."""
        return DATA / "v0" / self.name / system

    def root(self, system: str) -> str:
        """Where a system's tables live."""
        return f"s3://{BUCKET}/v0/{system}" if self.storage == "s3" else str(self.local_dir(system) / "lake")

    def state_path(self, system: str) -> Path:
        """The state file of a system."""
        return self.local_dir(system) / "state.json"

    def load_state(self, system: str) -> dict[str, Any]:
        """What ``v0/ingest.py`` left: table locations by name, the phase, when ingest finished."""
        return json.loads(self.state_path(system).read_text())

    def save_state(self, system: str, state: dict[str, Any]) -> None:
        """Writes a system's state for the readers."""
        path = self.state_path(system)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(state, indent=2))

    def storage_stats(self, system: str) -> StorageStats:
        """Objects and bytes under a system's root (all files: data and metadata)."""
        import pyarrow.fs as pafs

        if self.storage == "s3":
            fs, base = SETUP_PROXY.pyarrow_fs(), f"{BUCKET}/v0/{system}"
        else:
            fs, base = pafs.LocalFileSystem(), self.root(system)
        infos = fs.get_file_info(pafs.FileSelector(base, recursive=True, allow_not_found=True))
        files = [i for i in infos if i.type == pafs.FileType.File]
        data = [i for i in files if i.path.endswith((".parquet", ".lance")) and "/metadata/" not in i.path]
        return {
            "objects": len(files),
            "bytes": sum(i.size for i in files),
            "data_files": len(data),
            "data_bytes": sum(i.size for i in data),
        }

    def log(self, record: IngestRecord) -> None:
        """Appends an ingest or maintenance record to ``results/$V0_INGEST_LOG`` (default ``v0_ingest.jsonl``)."""
        if self.name != self.storage:
            record["target"] = self.name
        if machine := os.environ.get("BENCH_MACHINE"):
            record["machine"] = machine
        append_jsonl(RESULTS / os.environ.get("V0_INGEST_LOG", "v0_ingest.jsonl"), record)
