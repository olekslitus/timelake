import type { Metadata } from "next"
import Link from "next/link"

import { DocPage } from "@/components/docs/pager"

export const metadata: Metadata = { title: "Quick start" }

export default function Page() {
  return (
    <DocPage href="/docs/quick-start">
      <h1>Quick start</h1>
      <p>Build the CLI and the Python package from the repository, create a table, load data and query it.</p>

      <h2>Install</h2>
      <p>The CLI needs Rust 1.94 (pinned in <code>rust-toolchain.toml</code>):</p>
      <pre>{`cargo build --release -p timelake-cli     # → target/release/timelake`}</pre>
      <p>The Python package needs Python 3.10+ and builds with maturin:</p>
      <pre>{`cd crates/timelake-py
maturin develop --release                  # or: pip install .`}</pre>

      <h2>Choose a warehouse</h2>
      <p>
        A warehouse is a root location; tables live under it as <code>namespace/table</code>. Use a local path to try things
        out, or an object store URL:
      </p>
      <pre>{`export TIMELAKE_WAREHOUSE=./warehouse                 # local directory
export TIMELAKE_WAREHOUSE=s3://my-bucket/lake          # S3 (credentials from AWS_* env vars)`}</pre>
      <p>
        For S3-compatible stores and other options, see <Link href="/docs/storage">Storage & configuration</Link>.
      </p>

      <h2>Load data with the CLI</h2>
      <p>
        <code>import</code> creates the table from the first file’s schema if it doesn’t exist, then appends the files.
        Parquet and CSV (<code>.csv</code>, <code>.csv.gz</code>, <code>.tsv</code>) are supported.
      </p>
      <pre>{`timelake import iot.readings readings.parquet --time-column time --series-key device_id
timelake import iot.devices devices.csv          # a plain table: no time column
timelake info iot.readings                        # contract, files, partitions, snapshots`}</pre>

      <h2>Query</h2>
      <pre>{`timelake sql "SELECT device_id, time_bucket(INTERVAL '1 hour', time) AS hour, avg(temp)
              FROM iot.readings
              WHERE time >= TIMESTAMP '2026-01-01 00:00:00'
              GROUP BY 1, 2 ORDER BY 1, 2"

timelake latest iot.readings                      # newest row per device`}</pre>

      <h2>The same from Python</h2>
      <pre>{`import pyarrow as pa
import timelake

lake = timelake.Lake("./warehouse")
t = lake.create_table("iot.readings", batch.schema,
                      time_column="time", series_key=["device_id"])
t.append(batch)                       # pyarrow Table/RecordBatch/reader, polars DataFrame, ...

lake.sql("SELECT count(*) FROM iot.readings")    # -> pyarrow.Table
lake.latest("iot.readings")                      # -> pyarrow.Table, one row per device`}</pre>

      <h2>Read it from plain DuckDB</h2>
      <pre>{`INSTALL iceberg; LOAD iceberg;
SELECT * FROM iceberg_scan('./warehouse/iot/readings') LIMIT 10;`}</pre>
      <p>
        <code>timelake duckdb iot.readings</code> prints this SQL for a table, including the location of its last-value index.
      </p>

      <h2>Keep it healthy</h2>
      <p>
        Appends compact small files and expire snapshots inline, so a single writer needs nothing else. To rewrite each
        partition into one sorted file, apply retention and clean up, run:
      </p>
      <pre>{`timelake maintain                 # all tables
timelake maintain iot.readings    # one table`}</pre>
    </DocPage>
  )
}
