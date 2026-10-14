"""Timelake: the open time-series lakehouse.

    import timelake, pyarrow as pa
    lake = timelake.Lake("s3://bucket/warehouse")           # or a local path
    t = lake.create_table("iot.readings", schema, time_column="time", series_key=["device_id"])
    t.append(batch)                                          # Arrow in: pyarrow, polars, ...
    lake.sql("SELECT * FROM iot.readings WHERE device_id = 7 AND time > now() - INTERVAL '1 hour'")
    lake.latest("iot.readings")                              # newest row per device, from the index
    t.maintain()                                             # compaction/retention/expiry (also runs inline)

Tables are plain Iceberg + Parquet: `duckdb.sql("SELECT * FROM iceberg_scan('<table location>')")`.
"""

from ._timelake import ConflictError, Lake, Table

__all__ = ["ConflictError", "Lake", "Table"]
