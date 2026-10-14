import type { Metadata } from "next"

import { DocPage } from "@/components/docs/pager"

export const metadata: Metadata = { title: "CLI reference" }

function Flags({ rows }: { rows: [string, string][] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Flag</th>
          <th>Meaning</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([f, m]) => (
          <tr key={f}>
            <td>
              <code>{f}</code>
            </td>
            <td>{m}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const TABLE_DEF: [string, string][] = [
  ["--from <file>", "Take the schema from this Parquet or CSV file."],
  [
    "--schema <name:type,…>",
    "Schema inline. Types: int (int32), bigint (long, int64), double (float64), float (float32, real), string (text, varchar), bool, date, timestamp, timestamptz.",
  ],
  ["--time-column <col>", "The time column; makes this a time-series table."],
  ["--series-key <a,b>", "Columns that identify a series, comma-separated."],
  ["--chunk <hour|day|month>", "Time partition size (default day). Also accepts 1h, 1d, 24h, 1 month."],
  ["--retention <dur>", "Drop data older than this, e.g. 90d (units s, m, h, d, w, y)."],
  ["--no-dedup", "Keep rows with identical (series, time) during compaction."],
  ["--prop <k=v>", "Extra table property; repeatable."],
]

const LOAD: [string, string][] = [
  ["--rows-per-commit <n>", "Rows per commit (default 10,000,000; 0 = one commit per input file)."],
  ["--no-maintain", "Skip inline auto-maintenance after each commit."],
  [
    "--batch-id <id>",
    "Idempotency key; the commit number is appended (id-0, id-1, …), so re-running the same load is a no-op.",
  ],
]

export default function Page() {
  return (
    <DocPage href="/docs/cli">
      <h1>CLI reference</h1>
      <pre>{`timelake [-w <warehouse>] [-o key=value]... <command>`}</pre>
      <p>
        Every command prints help with <code>--help</code>, for example <code>timelake import --help</code>.{" "}
        <code>timelake --version</code> prints the version.
      </p>

      <h2>Global options</h2>
      <Flags
        rows={[
          [
            "-w, --warehouse <url|path>",
            "Warehouse location: s3://bucket/prefix, gs://…, az://…, file:///… or a local path. Env: TIMELAKE_WAREHOUSE. Default ./warehouse.",
          ],
          [
            "-o, --option <key=value>",
            "Storage option, repeatable, e.g. -o aws_endpoint=http://localhost:9000 -o aws_allow_http=true.",
          ],
        ]}
      />

      <h2>create</h2>
      <p>
        Create a table. The schema comes from a file (<code>--from</code>) or <code>--schema</code>.
      </p>
      <pre>{`timelake create iot.readings --from sample.parquet --time-column time --series-key device_id
timelake create iot.devices --schema "device_id:string,site:string,installed:date"`}</pre>
      <Flags rows={TABLE_DEF} />

      <h2>append</h2>
      <p>Append Parquet or CSV files to an existing table.</p>
      <pre>{`timelake append iot.readings day1.parquet day2.parquet --batch-id load-2026-01`}</pre>
      <Flags rows={LOAD} />

      <h2>import</h2>
      <p>
        Create the table if it doesn’t exist (schema from the first file, or <code>--from</code>/<code>--schema</code>),
        then append the files. Takes the flags of both <code>create</code> and <code>append</code>.
      </p>
      <pre>{`timelake import iot.readings readings/*.parquet --time-column time --series-key device_id --retention 365d`}</pre>
      <p>
        Inputs: <code>.parquet</code> files or directories of Parquet, and <code>.csv</code>, <code>.csv.gz</code> and{" "}
        <code>.tsv</code> with a header row.
      </p>

      <h2>sql</h2>
      <p>
        Run SQL given as an argument or on stdin. Several statements separated by <code>;</code> run in order.
      </p>
      <pre>{`timelake sql "SELECT count(*) FROM iot.readings"
echo "SELECT * FROM readings LIMIT 5" | timelake sql --namespace iot --format csv`}</pre>
      <Flags
        rows={[
          [
            "--format <table|csv|json|none>",
            "Output format (default table). json writes one JSON object per line (newline-delimited), nulls included. none prints only the row count.",
          ],
          ["--namespace <ns>", "Namespace for unqualified table names (default default)."],
          ["--set <key=value>", "DataFusion setting, e.g. --set datafusion.execution.target_partitions=32."],
        ]}
      />

      <h2>latest</h2>
      <p>
        Print the newest row of every series. It reads the last-value index; a table without one (for example, one first
        written by another tool) is scanned instead. Takes <code>--format</code> like <code>sql</code>.
      </p>
      <pre>{`$ timelake latest iot.readings --format json
{"time":"2026-01-05T10:15:00","device_id":"pump-1","temp":64.0,"humidity":40}
{"time":"2026-01-05T10:10:00","device_id":"pump-2","temp":60.2,"humidity":44}`}</pre>

      <h2>maintain</h2>
      <p>Compact, apply retention and expire snapshots, for the given tables or all tables.</p>
      <pre>{`timelake maintain
timelake maintain iot.readings --no-expire`}</pre>
      <Flags
        rows={[
          ["--no-compact", "Skip compaction."],
          ["--no-retention", "Skip dropping partitions past the retention period."],
          ["--no-expire", "Skip snapshot expiry and file cleanup."],
        ]}
      />

      <h2>info</h2>
      <p>Show a table’s contract, schema, size, snapshots, last-value index and newest partitions.</p>
      <pre>{`timelake info iot.readings
timelake info iot.readings --json`}</pre>

      <h2>ls</h2>
      <p>
        List tables as <code>namespace.table</code>; <code>--json</code> prints a JSON array.
      </p>

      <h2>duckdb</h2>
      <p>Print the DuckDB SQL that reads a table without Timelake, plus the location of its last-value index.</p>

      <h2>index</h2>
      <p>
        Rewrite <code>timelake-tables.json</code> in the warehouse root, the list of tables that readers use when they
        can&apos;t list objects (plain HTTPS, browsers, <code>@timelake/client</code>). Creating and dropping tables
        updates it automatically, so run this only after copying tables in by other means.
      </p>

      <h2>drop</h2>
      <p>Delete a table and all of its files. This cannot be undone.</p>
    </DocPage>
  )
}
