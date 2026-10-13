import type { Metadata } from "next"

import { DocPage } from "@/components/docs/pager"

export const metadata: Metadata = { title: "Table properties" }

const PROPS: [string, string, string][] = [
  ["timelake.time-column", "(none)", "The time column. Its presence makes the table a time-series table."],
  ["timelake.series-key", "(none)", "Comma-separated series key columns."],
  ["timelake.chunk-interval", "day", "Partition size: hour, day or month."],
  ["timelake.dedup", "true with a series key, else false", "Drop duplicate (series, time) rows during compaction; the latest write wins."],
  ["timelake.retention", "forever", "Drop partitions that end before now minus this duration, e.g. 90d."],
  ["timelake.auto-maintain", "true", "Run size-tiered compaction, retention and snapshot expiry inline after appends."],
  ["timelake.compact-min-files", "8", "Inline compaction merges a size tier of a partition once it has this many files."],
  ["timelake.target-file-size-bytes", "268435456 (256 MiB)", "Size at which compaction output and writes roll to a new file."],
  ["timelake.row-group-rows", "1048576", "Parquet row group size. Page indexes keep single-series reads selective inside large row groups."],
  ["timelake.snapshot-retention", "1h", "Expire snapshots older than this…"],
  ["timelake.min-snapshots", "5", "…but always keep at least this many,"],
  ["timelake.max-snapshots", "100", "and never keep more than this many (older ones expire even if younger than the retention)."],
]

export default function Page() {
  return (
    <DocPage href="/docs/table-properties">
      <h1>Table properties</h1>
      <p>
        A table’s contract and maintenance policy live in Iceberg table properties under the <code>timelake.</code> prefix.
        Other engines ignore them. Set them at creation with <code>--prop key=value</code> (CLI) or{" "}
        <code>properties=&#123;…&#125;</code> (Python); the contract flags (<code>--time-column</code>,{" "}
        <code>--series-key</code>, <code>--chunk</code>, <code>--retention</code>, <code>--no-dedup</code>) set the first five.
      </p>
      <table>
        <thead>
          <tr>
            <th>Property</th>
            <th>Default</th>
            <th>Meaning</th>
          </tr>
        </thead>
        <tbody>
          {PROPS.map(([k, d, m]) => (
            <tr key={k}>
              <td>
                <code>{k}</code>
              </td>
              <td>{d}</td>
              <td>{m}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Durations are a number and a unit: <code>s</code>, <code>m</code> (minutes), <code>h</code>, <code>d</code>,{" "}
        <code>w</code> or <code>y</code>, or the long forms (<code>90 days</code>, <code>2 weeks</code>). Examples:{" "}
        <code>30m</code>, <code>36h</code>, <code>90d</code>, <code>1y</code>.
      </p>

      <h2>Iceberg properties set at creation</h2>
      <ul>
        <li>
          <code>write.format.default = parquet</code> and <code>write.parquet.compression-codec = zstd</code>
        </li>
        <li>
          <code>write.metadata.previous-versions-max = 20</code>: keeps <code>metadata.json</code>, which every query reads,
          small. Older metadata files are deleted by snapshot expiry.
        </li>
      </ul>

      <h2>Schema</h2>
      <p>Arrow types are mapped to the closest lossless Iceberg type when a table is created:</p>
      <ul>
        <li>8- and 16-bit integers become <code>int</code>; <code>UInt32</code> becomes <code>long</code>; <code>UInt64</code> is rejected.</li>
        <li>Timestamps of any unit are stored in microseconds; time-zone-aware timestamps become <code>timestamptz</code> (UTC).</li>
        <li>Dictionary-encoded columns use their value type; large and view string and binary types become string and binary.</li>
        <li>The time column is NOT NULL, and a text time column is stored as a UTC timestamp.</li>
      </ul>
      <p>Schema evolution isn’t supported yet: the schema is fixed when the table is created.</p>
    </DocPage>
  )
}
