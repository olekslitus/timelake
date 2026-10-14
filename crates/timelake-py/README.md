# timelake

The open time-series lakehouse, for Python. Timelake keeps time series in your own bucket (S3 and S3-compatible
stores, Google Cloud Storage, Azure Blob Storage) or on local disk, as Apache Iceberg tables with Parquet files,
kept compact by the writer itself. Data goes in and out as Apache Arrow.

```bash
pip install timelake
```

```python
import timelake

lake = timelake.Lake("s3://lake/wh", storage_options={"aws_region": "eu-west-1"})
t = lake.create_table("iot.readings", batch.schema, time_column="time", series_key=["device_id"])
t.append(batch)                          # pyarrow Table/RecordBatch/reader, polars, ...

lake.sql("SELECT * FROM iot.readings WHERE device_id = 'pump-7' ORDER BY time DESC LIMIT 1")
lake.latest("iot.readings")              # pyarrow.Table, one row per device
```

- Docs: [timelake.dev/docs/python](https://timelake.dev/docs/python)
- Source: [github.com/polythings/timelake](https://github.com/polythings/timelake)

Licensed under the Apache License 2.0.
