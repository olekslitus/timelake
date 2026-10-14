import type { Metadata } from "next"
import Link from "next/link"

import { DocPage } from "@/components/docs/pager"

export const metadata: Metadata = { title: "Quick start" }

export default function Page() {
  return (
    <DocPage href="/docs/quick-start">
      <h1>Quick start</h1>
      <p>
        In about ten minutes: build the <code>timelake</code> command, load a small CSV file of sensor readings, query
        it, fix a bad reading, and read the same table from Python and DuckDB. Every output below is real.
      </p>

      <h2>1. Install</h2>
      <p>
        Timelake isn&apos;t published to package registries yet, so you build it from the repository. You need Rust (
        <code>rustup</code> installs the pinned version 1.94 on first use):
      </p>
      <pre>{`git clone https://github.com/polythings/timelake && cd timelake
cargo build --release -p timelake-cli      # takes a few minutes the first time
export PATH=$PWD/target/release:$PATH      # so "timelake" works from any folder`}</pre>

      <h2>2. Make some sample data</h2>
      <p>Two pumps report a temperature and humidity every five minutes. A second file describes the pumps.</p>
      <pre>{`mkdir -p ~/timelake-demo && cd ~/timelake-demo

cat > readings.csv <<'EOF'
time,device_id,temp,humidity
2026-01-05T10:00:00Z,pump-1,61.2,40
2026-01-05T10:00:00Z,pump-2,58.9,42
2026-01-05T10:05:00Z,pump-1,62.0,41
2026-01-05T10:05:00Z,pump-2,59.4,43
2026-01-05T10:10:00Z,pump-1,63.1,41
2026-01-05T10:10:00Z,pump-2,60.2,44
EOF

cat > devices.csv <<'EOF'
device_id,site,model
pump-1,plant-a,XR-200
pump-2,plant-b,XR-300
EOF`}</pre>

      <h2>3. Choose where tables live</h2>
      <p>
        A <strong>warehouse</strong> is the folder or bucket that holds your tables. Start with a local folder; later
        the same commands work with <code>s3://bucket/prefix</code> (see <Link href="/docs/storage">Storage</Link>).
      </p>
      <pre>{`export TIMELAKE_WAREHOUSE=./warehouse`}</pre>

      <h2>4. Load the data</h2>
      <p>
        <code>import</code> creates a table from the file&apos;s columns, then loads the rows. Tell it which column is
        the time and which column names the device (the <strong>series key</strong>):
      </p>
      <pre>{`$ timelake import iot.readings readings.csv --time-column time --series-key device_id
created iot.readings
  commit 0: 6 rows, 1 files, 0.0 MB, commit 2 ms [0.0s]
iot.readings: appended 6 rows in 1 commits, 0.01s (566 rows/s) → v2

$ timelake import iot.devices devices.csv        # no time column: a plain lookup table
created iot.devices
  commit 0: 2 rows, 1 files, 0.0 MB, commit 1 ms [0.0s]
iot.devices: appended 2 rows in 1 commits, 0.00s (767 rows/s) → v2

$ timelake ls
iot.devices
iot.readings`}</pre>
      <p>
        <code>iot</code> is the <strong>namespace</strong> (a group of tables) and <code>readings</code> the table name.
        Each load is one <strong>commit</strong>, which creates a new version of the table (<code>v2</code>).
      </p>

      <h2>5. Query it</h2>
      <p>Average and maximum temperature per pump in 10-minute buckets:</p>
      <pre>{`$ timelake sql "SELECT device_id, time_bucket(INTERVAL '10 minutes', time) AS bucket,
                       avg(temp) AS avg_temp, max(temp) AS max_temp
                FROM iot.readings GROUP BY 1, 2 ORDER BY 1, 2"
+-----------+---------------------+----------+----------+
| device_id | bucket              | avg_temp | max_temp |
+-----------+---------------------+----------+----------+
| pump-1    | 2026-01-05T10:00:00 | 61.6     | 62.0     |
| pump-1    | 2026-01-05T10:10:00 | 63.1     | 63.1     |
| pump-2    | 2026-01-05T10:00:00 | 59.15    | 59.4     |
| pump-2    | 2026-01-05T10:10:00 | 60.2     | 60.2     |
+-----------+---------------------+----------+----------+`}</pre>
      <p>The newest reading of every pump. This comes from a small index, not a scan of the table:</p>
      <pre>{`$ timelake latest iot.readings
+---------------------+-----------+------+----------+
| time                | device_id | temp | humidity |
+---------------------+-----------+------+----------+
| 2026-01-05T10:10:00 | pump-1    | 63.1 | 41       |
| 2026-01-05T10:10:00 | pump-2    | 60.2 | 44       |
+---------------------+-----------+------+----------+`}</pre>
      <p>Join readings with the device table, as in any SQL database:</p>
      <pre>{`$ timelake sql "SELECT d.site, r.device_id, r.temp
                FROM iot.readings r JOIN iot.devices d USING (device_id)
                WHERE r.time = TIMESTAMP '2026-01-05 10:10:00'"
+---------+-----------+------+
| site    | device_id | temp |
+---------+-----------+------+
| plant-a | pump-1    | 63.1 |
| plant-b | pump-2    | 60.2 |
+---------+-----------+------+`}</pre>

      <h2>6. Send a correction</h2>
      <p>
        Suppose <code>pump-1</code>&apos;s 10:10 reading was wrong. Send the corrected value, plus a new reading, as
        another file. The <code>--batch-id</code> makes the load safe to retry: running it twice loads it once.
      </p>
      <pre>{`$ cat > fix.csv <<'EOF'
time,device_id,temp,humidity
2026-01-05T10:10:00Z,pump-1,63.4,41
2026-01-05T10:15:00Z,pump-1,64.0,40
EOF

$ timelake append iot.readings fix.csv --batch-id gateway-7-000001
  commit 0: 2 rows, 1 files, 0.0 MB, commit 2 ms [0.0s]
$ timelake append iot.readings fix.csv --batch-id gateway-7-000001
  commit 0: 2 rows, 1 files, 0.0 MB, commit 0 ms (duplicate batch, skipped) [0.0s]`}</pre>
      <p>
        Both readings for 10:10 are in the table for now. <code>maintain</code> tidies the table: it merges small files
        and keeps only the last write for each pump and time.
      </p>
      <pre>{`$ timelake maintain iot.readings
iot.readings: compacted 1 partitions (2 → 1 files, 8 rows, 1 duplicates removed), … → v4

$ timelake sql "SELECT * FROM iot.readings WHERE device_id = 'pump-1' ORDER BY time"
+---------------------+-----------+------+----------+
| time                | device_id | temp | humidity |
+---------------------+-----------+------+----------+
| 2026-01-05T10:00:00 | pump-1    | 61.2 | 40       |
| 2026-01-05T10:05:00 | pump-1    | 62.0 | 41       |
| 2026-01-05T10:10:00 | pump-1    | 63.4 | 41       |
| 2026-01-05T10:15:00 | pump-1    | 64.0 | 40       |
+---------------------+-----------+------+----------+`}</pre>
      <p>
        You rarely need to run <code>maintain</code> yourself: every append already does the cheap part of this work.
        Run it on a schedule (cron, a Lambda) if you want each day&apos;s data in one sorted file and duplicates gone
        quickly.
      </p>

      <h2>7. Look at the table</h2>
      <pre>{`$ timelake info iot.readings
table      iot.readings (v4, Iceberg V2)
time       time (chunk day)
series key device_id
dedup      true
retention  forever
schema     time Timestamp(µs), device_id Utf8, temp Float64, humidity Int64
data       7 rows in 1 files, 0.0 MB
…`}</pre>
      <p>
        The table is a folder of ordinary files: Parquet for the data, Apache Iceberg metadata to list them.{" "}
        <Link href="/docs/how-it-works">How it works</Link> explains each file.
      </p>

      <h2>8. The same from Python</h2>
      <p>
        Build the Python package into a virtual environment in the demo folder (it compiles the Rust engine, so it takes
        a few minutes), then write and read with pyarrow:
      </p>
      <pre>{`cd ~/timelake-demo
uv venv && uv pip install pyarrow ~/timelake/crates/timelake-py    # path to your clone
source .venv/bin/activate && python`}</pre>
      <pre>{`import datetime as dt

import pyarrow as pa
import timelake

lake = timelake.Lake("./warehouse")

# A new table, created from a pyarrow schema
schema = pa.schema([
    ("time", pa.timestamp("us", tz="UTC")),
    ("device_id", pa.string()),
    ("temp", pa.float64()),
])
t = lake.create_table("iot.py_readings", schema, time_column="time", series_key=["device_id"])

t0 = dt.datetime(2026, 1, 5, 10, 0, tzinfo=dt.timezone.utc)
batch = pa.table(
    {"time": [t0, t0, t0 + dt.timedelta(minutes=5)], "device_id": ["pump-1", "pump-2", "pump-1"], "temp": [61.2, 58.9, 62.0]},
    schema=schema,
)
print(t.append(batch, batch_id="gateway-7-000001"))
# {'rows': 3, 'files': 1, 'bytes': 1399, 'version': 2, 'commit_ms': 6.8, 'attempts': 1, 'duplicate': False}

print(lake.sql("SELECT device_id, avg(temp) AS avg_temp FROM iot.py_readings GROUP BY 1 ORDER BY 1").to_pylist())
# [{'device_id': 'pump-1', 'avg_temp': 61.6}, {'device_id': 'pump-2', 'avg_temp': 58.9}]

print(lake.latest("iot.readings").to_pylist())   # the table loaded by the CLI above`}</pre>
      <p>
        Results come back as <code>pyarrow.Table</code>; call <code>.to_pandas()</code> or{" "}
        <code>polars.from_arrow(…)</code> if you prefer those. All methods are listed in the{" "}
        <Link href="/docs/python">Python API</Link>.
      </p>

      <h2>9. Read it from DuckDB</h2>
      <p>Other tools read the table without Timelake. In DuckDB:</p>
      <pre>{`INSTALL iceberg; LOAD iceberg;
SELECT device_id, count(*), max(temp)
FROM iceberg_scan('warehouse/iot/readings')
GROUP BY 1 ORDER BY 1;

┌───────────┬──────────────┬─────────────┐
│ device_id │ count_star() │ max("temp") │
├───────────┼──────────────┼─────────────┤
│ pump-1    │            4 │        64.0 │
│ pump-2    │            3 │        60.2 │
└───────────┴──────────────┴─────────────┘`}</pre>
      <p>
        <code>timelake duckdb iot.readings</code> prints this SQL for any table, plus the location of its latest-values
        index.
      </p>

      <h2>10. Move to object storage</h2>
      <p>Point the warehouse at a bucket. Credentials come from the usual AWS environment variables or profile:</p>
      <pre>{`export TIMELAKE_WAREHOUSE=s3://my-bucket/lake
export AWS_REGION=us-east-2
timelake import iot.readings readings.csv --time-column time --series-key device_id`}</pre>
      <p>
        For R2, MinIO, GCS and Azure, see <Link href="/docs/storage">Storage & configuration</Link>.
      </p>

      <h2>Next steps</h2>
      <ul>
        <li>
          <Link href="/docs/how-it-works">How it works</Link>: what happens on a write and a read.
        </li>
        <li>
          <Link href="/docs/querying">Querying</Link>: time buckets, latest values and which queries are fastest.
        </li>
        <li>
          <Link href="/docs/table-properties">Table properties</Link>: partition size, retention, deduplication.
        </li>
        <li>
          <Link href="/explore">Explorer</Link>: browse a demo warehouse in the browser.
        </li>
      </ul>
    </DocPage>
  )
}
