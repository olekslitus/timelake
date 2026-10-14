"""Types of the values the native module takes and returns."""

from __future__ import annotations

from typing import Protocol, TypedDict


class ArrowSchemaExportable(Protocol):
    """An object that exports an Arrow schema through the Arrow PyCapsule interface, e.g. a ``pyarrow.Schema``."""

    def __arrow_c_schema__(self) -> object:
        """Returns a PyCapsule holding an ``ArrowSchema``."""
        ...


class HasArrowSchema(Protocol):
    """An object with an Arrow ``.schema``, e.g. a ``pyarrow.Table``."""

    @property
    def schema(self) -> ArrowSchemaExportable:
        """The object's Arrow schema."""
        ...


class ArrowArrayExportable(Protocol):
    """One batch of Arrow data, e.g. a ``pyarrow.RecordBatch``."""

    def __arrow_c_array__(self, requested_schema: object | None = None) -> tuple[object, object]:
        """Returns PyCapsules holding an ``ArrowSchema`` and an ``ArrowArray``."""
        ...


class ArrowStreamExportable(Protocol):
    """A stream of Arrow batches, e.g. a ``pyarrow.Table``, ``RecordBatchReader`` or ``polars.DataFrame``."""

    def __arrow_c_stream__(self, requested_schema: object | None = None) -> object:
        """Returns a PyCapsule holding an ``ArrowArrayStream``."""
        ...


class MaintainReport(TypedDict):
    """What a maintenance run did."""

    partitions_compacted: int
    files_rewritten: int
    files_written: int
    rows_rewritten: int
    duplicates_removed: int
    partitions_dropped: int
    snapshots_expired: int
    objects_deleted: int
    seconds: float


class _AppendResult(TypedDict):
    rows: int
    files: int
    bytes: int
    version: int
    commit_ms: float
    attempts: int
    duplicate: bool


class AppendResult(_AppendResult, total=False):
    """Statistics of one append. ``maintenance`` is present only when inline maintenance ran."""

    maintenance: MaintainReport


class TableInfo(TypedDict):
    """Contract, size and layout of a table version."""

    name: str
    version: int
    location: str
    time_column: str | None
    series_key: list[str]
    chunk: str | None
    dedup: bool
    rows: int
    files: int
    bytes: int
    snapshots: int
    manifests: int
    last_value_index: str | None
