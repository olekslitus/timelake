# timelake-cli

The `timelake` command: create, load, query and maintain Timelake tables on object storage or local disk.

```bash
cargo install timelake-cli        # or download a binary from https://github.com/polythings/timelake/releases

export TIMELAKE_WAREHOUSE=./warehouse         # or s3://bucket/prefix
timelake import iot.readings readings.parquet --time-column time --series-key device_id
timelake sql "SELECT device_id, avg(temp) FROM iot.readings GROUP BY 1"
timelake latest iot.readings                  # newest row per device, from the index
timelake maintain                             # compaction, retention and snapshot expiry
```

- Reference: [timelake.dev/docs/cli](https://timelake.dev/docs/cli)
- Source: [github.com/polythings/timelake](https://github.com/polythings/timelake)

Licensed under the Apache License 2.0.
