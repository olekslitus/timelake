import type { Metadata } from "next"
import Link from "next/link"

import { DocPage } from "@/components/docs/pager"

export const metadata: Metadata = { title: "How it works" }

export default function Page() {
  return (
    <DocPage href="/docs/how-it-works">
      <h1>How it works</h1>
      <p>
        This page follows a small table from the first write to a query, and shows the files Timelake creates on the way. It
        uses the same data as the <Link href="/docs/quick-start">Quick start</Link>: two pumps reporting a temperature every
        five minutes.
      </p>

      <h2>The idea in one paragraph</h2>
      <p>
        Your data is a set of files in a folder or a bucket. There is no database server. When you write, Timelake turns your
        rows into files that are sorted and grouped by time, and records which files make up the table. When you read, it uses
        that record to open only the files, and only the parts of files, that can contain the answer. Everything Timelake
        needs to know is in those files, so any machine that can reach the bucket can read or write the table.
      </p>

      <h2>The building blocks</h2>
      <table>
        <thead>
          <tr>
            <th>Piece</th>
            <th>What it is</th>
            <th>Why Timelake uses it</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Object storage</td>
            <td>A place to keep files by name: S3, R2, Google Cloud Storage, Azure, MinIO, or a local folder.</td>
            <td>Cheap, durable and already where most companies keep their data. You pay per GB and per request.</td>
          </tr>
          <tr>
            <td>Parquet</td>
            <td>A file format that stores a table column by column, compressed, with small summaries (min and max values) for each block.</td>
            <td>A query that needs one column, or one time range, can read a small part of the file.</td>
          </tr>
          <tr>
            <td>Apache Iceberg</td>
            <td>A set of metadata files that says which Parquet files form a table, with their row counts and min and max values.</td>
            <td>It makes a folder of files behave like one table with versions, and many tools already read it (DuckDB, Spark, Trino, Snowflake).</td>
          </tr>
          <tr>
            <td>Apache Arrow</td>
            <td>The in-memory column format that data uses while it moves between programs.</td>
            <td>Python, Rust and the query engine share data without converting it.</td>
          </tr>
          <tr>
            <td>DataFusion</td>
            <td>A SQL engine written in Rust that Timelake embeds.</td>
            <td>Timelake adds its own table reader and rules to it, so SQL can use the time-series layout.</td>
          </tr>
        </tbody>
      </table>

      <h2>1. Creating the table</h2>
      <pre>{`timelake import iot.readings readings.csv --time-column time --series-key device_id`}</pre>
      <p>
        This tells Timelake two things about the data: which column holds the time (<code>time</code>) and which columns
        say which device a row belongs to (<code>device_id</code>, the <em>series key</em>). Those two choices decide how
        files are laid out. They are stored with the table, so every writer follows them.
      </p>

      <h2>2. Writing rows</h2>
      <p>The same command then appends the six rows of <code>readings.csv</code>. Timelake:</p>
      <ol>
        <li>
          <strong>Matches columns to the table</strong> by name and converts types (for example, text times become
          timestamps).
        </li>
        <li>
          <strong>Splits rows by day.</strong> Each day is a <em>partition</em>, a folder such as{" "}
          <code>time_day=2026-01-05</code>. A query for one day never opens another day&apos;s folder.
        </li>
        <li>
          <strong>Sorts each day by device, then time.</strong> All of <code>pump-1</code>&apos;s rows sit together, in time
          order. A query for one device reads one small stretch of the file.
        </li>
        <li>
          <strong>Writes a Parquet file</strong> per day, compressed, with min and max values for each block.
        </li>
        <li>
          <strong>Updates the last-value index</strong>, a tiny file with the newest row of every device.
        </li>
        <li>
          <strong>Commits</strong>: writes new metadata that lists the new file, and makes it the current version of the
          table.
        </li>
      </ol>
      <p>After the first append, the warehouse holds these files:</p>
      <pre>{`warehouse/
  timelake-tables.json                    the list of tables, for readers that can't list a bucket
  iot/readings/
    data/
      time_day=2026-01-05/
        01a137a8-….parquet                the six rows, sorted by device and time
    metadata/
      v1.metadata.json                    version 1: the empty table (schema, settings)
      v2.metadata.json                    version 2: the table after the append
      version-hint.text                   "2": which version is current
      snap-2566…-….avro                   manifest list: the manifests of version 2
      7e01002d-…-added-m.avro             manifest: the data files, with row counts and min/max values
      lvi-2566…-….parquet                 last-value index: newest row per device`}</pre>
      <p>
        The <code>metadata/</code> folder is standard Iceberg. Reading a table means following a chain:{" "}
        <code>version-hint.text</code> → <code>v2.metadata.json</code> → manifest list → manifests → data files.
      </p>

      <h2>3. Two writers at the same time</h2>
      <p>
        There is no server to coordinate writers, so the commit itself has to be safe. Every commit creates the next metadata
        file, say <code>v3.metadata.json</code>, with a <em>conditional write</em>: &quot;create this file only if it
        doesn&apos;t exist yet&quot;. Object stores do this check atomically. If two writers try at once, exactly one
        succeeds. The other sees that <code>v3</code> exists, reloads the table, and tries again as <code>v4</code>. Its data
        files are already written, so the retry is cheap.
      </p>
      <p>
        A writer can also attach a <strong>batch id</strong> to an append. If the same id was already committed, the append
        does nothing. That makes retries safe, for example when a network call timed out but the commit actually went
        through:
      </p>
      <pre>{`$ timelake append iot.readings fix.csv --batch-id gateway-7-000001
  commit 0: 2 rows, 1 files, 0.0 MB, commit 2 ms [0.0s]
$ timelake append iot.readings fix.csv --batch-id gateway-7-000001
  commit 0: 2 rows, 1 files, 0.0 MB, commit 0 ms (duplicate batch, skipped) [0.0s]`}</pre>

      <h2>4. Reading</h2>
      <pre>{`timelake sql "SELECT device_id, avg(temp) FROM iot.readings
              WHERE device_id = 'pump-1' AND time >= TIMESTAMP '2026-01-05 10:00:00'
              GROUP BY 1"`}</pre>
      <p>For a query like this, the reader:</p>
      <ol>
        <li>
          <strong>Loads the current version</strong> by following the metadata chain above. It reads every table in the
          query at the same time, so a join doesn&apos;t wait for one table before the next.
        </li>
        <li>
          <strong>Skips whole files.</strong> The manifests hold each file&apos;s min and max time and device. A file whose
          times all fall before 10:00, or whose devices are all <code>pump-2</code>, is never opened.
        </li>
        <li>
          <strong>Skips parts of files.</strong> Inside a file, Parquet keeps min and max values per block (row groups and
          pages). Because rows are sorted by device and time, one device&apos;s rows are in a few blocks, and the rest are
          skipped.
        </li>
        <li>
          <strong>Reads only the needed columns</strong> (<code>device_id</code>, <code>time</code>, <code>temp</code>)
          and runs the SQL on them.
        </li>
      </ol>

      <h3>The newest value of every device</h3>
      <p>
        &quot;What is each device doing right now?&quot; is the most common question for this kind of data, and the most
        expensive one for a normal engine: it has to look at every row to find each device&apos;s newest one. Timelake keeps
        the answer ready in the last-value index and rewrites such queries to read it:
      </p>
      <pre>{`$ timelake latest iot.readings
+---------------------+-----------+------+----------+
| time                | device_id | temp | humidity |
+---------------------+-----------+------+----------+
| 2026-01-05T10:10:00 | pump-1    | 63.1 | 41       |
| 2026-01-05T10:10:00 | pump-2    | 60.2 | 44       |
+---------------------+-----------+------+----------+`}</pre>
      <p>
        The same happens for plain SQL written in the usual ways, such as{" "}
        <code>ORDER BY time DESC LIMIT 1</code> for one device. See <Link href="/docs/querying">Querying</Link> for the
        exact shapes.
      </p>

      <h2>5. Keeping the table tidy</h2>
      <p>Frequent small appends leave the table in a state that gets slower over time:</p>
      <ul>
        <li>
          <strong>Many small files.</strong> Each append adds at least one file per day it touches, and every file costs a
          request to open.
        </li>
        <li>
          <strong>Duplicates.</strong> A device may send the same reading twice, or a corrected one.
        </li>
        <li>
          <strong>Old versions.</strong> Every commit keeps the previous versions and their files around.
        </li>
      </ul>
      <p>
        Other systems run separate jobs for this (AWS Glue, Spark, S3 Tables&apos; managed compaction). Timelake does it in
        the writer: after an append it merges small files once enough of a similar size pile up, and it expires old versions
        in batches. <code>timelake maintain</code> does a full pass on demand. It rewrites each day into sorted files, removes
        duplicates (the latest write wins), drops data past the retention period, and deletes files no version needs any
        more.
      </p>
      <pre>{`$ timelake sql "SELECT * FROM iot.readings WHERE device_id = 'pump-1' ORDER BY time"
| 2026-01-05T10:10:00 | pump-1    | 63.1 | 41       |    ← first reading
| 2026-01-05T10:10:00 | pump-1    | 63.4 | 41       |    ← corrected reading, same time
$ timelake maintain iot.readings
iot.readings: compacted 1 partitions (2 → 1 files, 8 rows, 1 duplicates removed) …
$ timelake sql "SELECT * FROM iot.readings WHERE device_id = 'pump-1' ORDER BY time"
| 2026-01-05T10:10:00 | pump-1    | 63.4 | 41       |    ← only the latest write is left`}</pre>

      <h2>6. Reading without Timelake</h2>
      <p>
        The table is ordinary Iceberg and Parquet, so other tools read it with no Timelake software. DuckDB, for example:
      </p>
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
        These tools see the same rows. They don&apos;t get the last-value index or Timelake&apos;s query rewrites, so the
        same queries are usually slower.
      </p>

      <h2>Why requests matter on S3</h2>
      <p>
        On a local disk, opening a file takes microseconds. On S3, every request takes tens of milliseconds before the first
        byte arrives, and costs money. So Timelake tries to make fewer requests and to send them in parallel:
      </p>
      <ul>
        <li>Fewer, larger files after compaction.</li>
        <li>Skipping files and blocks using min and max values.</li>
        <li>The last-value index, which answers &quot;latest&quot; questions with one small file.</li>
        <li>Loading all tables of a query at once, and reading each file&apos;s footer (its table of contents) once.</li>
      </ul>
      <p>
        On real AWS S3, the &quot;latest position of every truck&quot; query took 18 requests with Timelake and 1,733 with a
        plain Iceberg table. See <Link href="/benchmarks">Benchmarks</Link> for the full results.
      </p>
    </DocPage>
  )
}
