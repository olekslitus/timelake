import type { Metadata } from "next"

import { DocPage } from "@/components/docs/pager"

export const metadata: Metadata = { title: "Python API" }

export default function Page() {
  return (
    <DocPage href="/docs/python">
      <h1>Python API</h1>
      <p>
        The <code>timelake</code> package wraps the Rust library with PyO3. Data goes in and out as Apache Arrow, so pyarrow,
        polars and anything that implements the Arrow C stream interface work without copies. Calls release the GIL while they
        run.
      </p>
      <pre>{`import timelake`}</pre>

      <h2>Lake</h2>
      <pre>{`lake = timelake.Lake(location, storage_options=None)`}</pre>
      <p>
        Opens a warehouse. <code>location</code> is a local path or an <code>s3://</code>, <code>gs://</code>,{" "}
        <code>az://</code> or <code>file://</code> URL; <code>storage_options</code> is a dict of object store options (see{" "}
        Storage & configuration). <code>lake.location</code> returns the normalized URL.
      </p>
      <table>
        <thead>
          <tr>
            <th>Method</th>
            <th>Returns</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>create_table(name, schema, time_column=None, series_key=None, chunk=None, retention=None, dedup=None, properties=None)</code>
            </td>
            <td>
              <code>Table</code>. <code>schema</code> is a pyarrow schema or anything with a <code>.schema</code>.{" "}
              <code>chunk</code> is &quot;hour&quot;, &quot;day&quot; or &quot;month&quot;; <code>retention</code> a duration
              such as &quot;90d&quot;; <code>properties</code> extra table properties.
            </td>
          </tr>
          <tr>
            <td>
              <code>table(name)</code>
            </td>
            <td>
              <code>Table</code> at its latest version.
            </td>
          </tr>
          <tr>
            <td>
              <code>tables()</code>
            </td>
            <td>
              <code>list[str]</code> of <code>namespace.table</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>sql(query, namespace=&quot;default&quot;)</code>
            </td>
            <td>
              <code>pyarrow.Table</code>. Unqualified names resolve in <code>namespace</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>latest(table)</code>
            </td>
            <td>
              <code>pyarrow.Table</code> with the newest row per series.
            </td>
          </tr>
          <tr>
            <td>
              <code>drop_table(name)</code>
            </td>
            <td>Deletes the table and its files.</td>
          </tr>
        </tbody>
      </table>

      <h2>Table</h2>
      <p>
        Properties: <code>name</code>, <code>location</code>, <code>version</code>, <code>schema</code> (pyarrow). Methods that
        commit advance the handle to the new version.
      </p>
      <table>
        <thead>
          <tr>
            <th>Method</th>
            <th>Returns</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>append(data, batch_id=None, maintain=None)</code>
            </td>
            <td>
              dict: <code>rows</code>, <code>files</code>, <code>bytes</code>, <code>version</code>, <code>commit_ms</code>,{" "}
              <code>attempts</code>, <code>duplicate</code>, and <code>maintenance</code> when inline maintenance did work.{" "}
              <code>maintain</code> overrides the table’s auto-maintain setting.
            </td>
          </tr>
          <tr>
            <td>
              <code>maintain(compact=True, retention=True, expire=True)</code>
            </td>
            <td>
              dict: <code>partitions_compacted</code>, <code>files_rewritten</code>, <code>files_written</code>,{" "}
              <code>rows_rewritten</code>, <code>duplicates_removed</code>, <code>partitions_dropped</code>,{" "}
              <code>snapshots_expired</code>, <code>objects_deleted</code>, <code>seconds</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>info()</code>
            </td>
            <td>
              dict: contract (<code>time_column</code>, <code>series_key</code>, <code>chunk</code>, <code>dedup</code>), size
              (<code>rows</code>, <code>files</code>, <code>bytes</code>), <code>snapshots</code>, <code>manifests</code>,{" "}
              <code>last_value_index</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>refresh()</code>
            </td>
            <td>Reloads the latest committed version.</td>
          </tr>
        </tbody>
      </table>

      <h2>Input data</h2>
      <p>
        <code>append</code> accepts a pyarrow <code>RecordBatch</code>, <code>Table</code> or <code>RecordBatchReader</code>,
        a polars DataFrame, or any object with <code>__arrow_c_stream__</code>. Columns are matched by name and cast to the
        table types; missing nullable columns become nulls, and columns not in the table are an error.
      </p>

      <h2>Errors</h2>
      <table>
        <thead>
          <tr>
            <th>Exception</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>KeyError</code>
            </td>
            <td>The table doesn’t exist.</td>
          </tr>
          <tr>
            <td>
              <code>FileExistsError</code>
            </td>
            <td>Creating a table that already exists.</td>
          </tr>
          <tr>
            <td>
              <code>ValueError</code>
            </td>
            <td>Invalid input or configuration (schema mismatch, bad option, bad duration).</td>
          </tr>
          <tr>
            <td>
              <code>RuntimeError</code>
            </td>
            <td>Storage, query or commit failures, including a commit conflict that could not be rebased.</td>
          </tr>
        </tbody>
      </table>

      <h2>Example</h2>
      <pre>{`import datetime as dt
import pyarrow as pa
import timelake

lake = timelake.Lake("s3://my-bucket/lake", storage_options={"aws_region": "eu-west-1"})
schema = pa.schema([("time", pa.timestamp("us", tz="UTC")), ("device_id", pa.string()), ("temp", pa.float64())])
t = lake.create_table("iot.readings", schema, time_column="time", series_key=["device_id"], retention="365d")

batch = pa.table({"time": [dt.datetime.now(dt.timezone.utc)], "device_id": ["pump-7"], "temp": [71.5]}, schema=schema)
print(t.append(batch, batch_id="gateway-3-000042"))

hourly = lake.sql("""
  SELECT time_bucket(INTERVAL '1 hour', time) AS hour, avg(temp) AS temp
  FROM iot.readings WHERE device_id = 'pump-7' GROUP BY 1 ORDER BY 1
""")`}</pre>
    </DocPage>
  )
}
