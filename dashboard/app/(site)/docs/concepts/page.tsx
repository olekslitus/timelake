import type { Metadata } from "next"
import Link from "next/link"

import { DocPage } from "@/components/docs/pager"

export const metadata: Metadata = { title: "Concepts" }

export default function Page() {
  return (
    <DocPage href="/docs/concepts">
      <h1>Concepts</h1>

      <h2 id="warehouse">Warehouse and tables</h2>
      <p>
        A <strong>warehouse</strong> is a root location such as <code>s3://bucket/lake</code> or a local directory. Each
        table lives at <code>&lt;warehouse&gt;/&lt;namespace&gt;/&lt;table&gt;</code> and is addressed as{" "}
        <code>namespace.table</code>; a bare name means the <code>default</code> namespace. Namespaces and table names
        use letters, digits, <code>_</code> and <code>-</code>.
      </p>

      <h2 id="kinds">Time-series and plain tables</h2>
      <p>
        A <strong>time-series table</strong> has a time column. It is partitioned by time, sorted, indexed by series and
        maintained automatically. A <strong>plain table</strong> has no time column (device metadata, dimension tables):
        it is unpartitioned and unsorted, and you join it to time-series tables in SQL.
      </p>

      <h2 id="contract">The table contract</h2>
      <p>
        Like a TimescaleDB hypertable, a time-series table follows a small contract stored as Iceberg table properties
        (see <Link href="/docs/table-properties">Table properties</Link>):
      </p>
      <table>
        <thead>
          <tr>
            <th>Element</th>
            <th>Meaning</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>time column</td>
            <td>
              Required for time-series tables. A timestamp, stored with microsecond precision and NOT NULL. Text times
              (from CSV) are parsed as UTC.
            </td>
          </tr>
          <tr>
            <td>series key</td>
            <td>
              Optional columns that identify a series, e.g. <code>device_id</code> or <code>(site, metric)</code>.
            </td>
          </tr>
          <tr>
            <td>chunk interval</td>
            <td>
              Partition size: <code>hour</code>, <code>day</code> (default) or <code>month</code>.
            </td>
          </tr>
          <tr>
            <td>dedup</td>
            <td>
              Remove rows with the same series key and time during compaction; the latest write wins. On by default when
              a series key is set.
            </td>
          </tr>
          <tr>
            <td>retention</td>
            <td>Optional; whole partitions older than this are dropped by maintenance.</td>
          </tr>
        </tbody>
      </table>

      <h2 id="layout">Partitions and sort order</h2>
      <p>
        Rows are split into partitions by the chunk interval of the time column (Iceberg’s <code>hour</code>,{" "}
        <code>day</code> or <code>month</code> transform), and each file is sorted by <code>(series key…, time)</code>.
        Files record their sort order, and Parquet statistics and page indexes let readers skip row groups and pages
        that cannot match a series or time filter.
      </p>

      <h2 id="snapshots">Commits and snapshots</h2>
      <p>
        Every append, compaction, retention run and expiry is one atomic Iceberg commit producing a new table version. A
        commit writes the next <code>vN.metadata.json</code> only if it does not exist yet, so exactly one of several
        concurrent writers wins and the others retry on top of it. An append can carry a <strong>batch id</strong>;
        appending the same batch id again is a no-op, which makes retries safe.
      </p>

      <h2 id="lvi">Last-value index</h2>
      <p>
        Each append updates a small Parquet file holding the newest row of every series (on equal times, the later write
        wins), and the new snapshot references it. A table whose first rows were written by another tool has no index;
        latest-row queries on it scan the table instead. <code>timelake latest</code> and <code>Lake.latest()</code>{" "}
        read it, and the reader rewrites latest-row SQL to use it (see <Link href="/docs/querying">Querying</Link>).
      </p>

      <h2 id="maintenance">Maintenance</h2>
      <ul>
        <li>
          <strong>Inline (default).</strong> After each append, small files in the touched partitions that have grown
          into a group of similar size are merged, partitions past the retention period are dropped, and old snapshots
          are expired in batches.
        </li>
        <li>
          <strong>Explicit.</strong> <code>timelake maintain</code> (or <code>Table.maintain()</code>) rewrites each
          partition with several small or unsorted files into sorted, deduplicated files of the target size, drops
          partitions past retention, expires snapshots and deletes files no snapshot references any more.
        </li>
      </ul>
      <p>
        Both are safe to run while others write: they commit like any writer and abort if the files they rewrote were
        changed concurrently.
      </p>
    </DocPage>
  )
}
