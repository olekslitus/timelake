# timelake

The open time-series lakehouse, as a Rust library. Timelake keeps time series in your own bucket (S3 and
S3-compatible stores, Google Cloud Storage, Azure Blob Storage) or on local disk, as Apache Iceberg tables with
Parquet files. Tables are partitioned by time and sorted by `(series key, time)`, the writer keeps them compact,
and queries run on Apache DataFusion.

```rust
use timelake::{Lake, Session, TableOptions};

let lake = Lake::open("s3://bucket/warehouse", Default::default())?;
let opts = TableOptions {
    time_column: Some("time".into()),
    series_key: vec!["device_id".into()],
    ..Default::default()
};
let table = lake.create_table("iot.readings", &batch.schema(), opts).await?;
let (table, result) = table.append(&[batch], Default::default()).await?;

let session = Session::new(lake);
let rows = session.sql("SELECT * FROM iot.readings WHERE device_id = 7").await?.collect().await?;
let latest = session.latest("iot.readings").await?.collect().await?;
```

- Docs: [timelake.dev/docs](https://timelake.dev/docs)
- Command-line tool: [`timelake-cli`](https://crates.io/crates/timelake-cli)
- Python: [`timelake` on PyPI](https://pypi.org/project/timelake/)
- Source: [github.com/polythings/timelake](https://github.com/polythings/timelake)

Licensed under the Apache License 2.0.
