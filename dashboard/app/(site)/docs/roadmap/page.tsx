import type { Metadata } from "next"

import { DocPage } from "@/components/docs/pager"

export const metadata: Metadata = { title: "Roadmap & limitations" }

export default function Page() {
  return (
    <DocPage href="/docs/roadmap">
      <h1>Roadmap & limitations</h1>

      <h2>Known limitations in v0</h2>
      <ul>
        <li>
          <strong>No REST catalog.</strong> Tables are found by path (Hadoop-catalog layout). Engines that only speak
          the Iceberg REST protocol can’t attach yet.
        </li>
        <li>
          <strong>Freshness is per commit.</strong> Data is visible when its append commits; there is no hot tier or
          write-ahead log for sub-commit freshness.
        </li>
        <li>
          <strong>No deletes.</strong> Row-level deletes, the delete audit trail and GDPR erasure are designed but not
          built. Retention drops whole partitions only.
        </li>
        <li>
          <strong>No schema evolution.</strong> The schema is fixed at creation.
        </li>
        <li>
          <strong>Duplicates until compaction.</strong> Dedup happens during compaction, not at read time.
        </li>
        <li>
          <strong>In-memory compaction.</strong> A partition is merged in memory; size the chunk interval so partitions
          fit.
        </li>
        <li>
          <strong>Planning cache.</strong> A process reuses a table version it loaded within the last second for query
          planning (its own commits are always visible).
        </li>
        <li>
          <strong>Replaced files linger.</strong> Files removed by compaction are deleted when the snapshots that
          reference them expire: at least an hour later by default, and inline expiry waits until about 20 extra
          snapshots have piled up.
        </li>
        <li>
          <strong>Benchmarks are narrow.</strong> One dataset (TSBS IoT). The AWS S3 runs were made from a laptop, so
          their latency includes the trip to the region; runs from inside AWS are next.
        </li>
        <li>
          <strong>Tested storage.</strong> Local disk, RustFS, AWS S3, and S3 Express One Zone (correctness only). GCS,
          Azure and R2 use the same code paths but haven’t been tested yet.
        </li>
      </ul>

      <h2>Planned</h2>
      <table>
        <thead>
          <tr>
            <th>Area</th>
            <th>What</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Catalog</td>
            <td>An optional Iceberg REST endpoint over the same layout, so any REST-capable engine can attach.</td>
          </tr>
          <tr>
            <td>Deletes</td>
            <td>
              Immutable, audited deletes with deletion vectors (Iceberg v3), undelete, and GDPR purge with a 7-day
              maximum delay.
            </td>
          </tr>
          <tr>
            <td>Backfill & import</td>
            <td>Branch-staged backfill with atomic publish; import from Iceberg/S3 Tables and TimescaleDB.</td>
          </tr>
          <tr>
            <td>Aggregates</td>
            <td>
              Incremental continuous aggregates stored as Iceberg tables, and a time-series function library (gap
              filling, time-weighted averages, counters, percentiles).
            </td>
          </tr>
          <tr>
            <td>Freshness</td>
            <td>An optional hot tier (object-store WAL or Valkey) merged by the reader for second-level freshness.</td>
          </tr>
          <tr>
            <td>Ingestion</td>
            <td>
              A Telegraf/Firehose-style pipeline (MQTT, HTTP, Kafka) with in-stream rules and alarms, deployable as a
              library, Lambda or container.
            </td>
          </tr>
          <tr>
            <td>DuckDB</td>
            <td>A DuckDB extension with dedup on read, index-aware scans and the function library.</td>
          </tr>
          <tr>
            <td>Reader</td>
            <td>A data cache for repeat queries, and more query shapes served from indexes.</td>
          </tr>
          <tr>
            <td>Performance</td>
            <td>
              Fewer round trips to object storage: the table state in one request, file footers stored with it, two-step
              commits. See SPEC §19.1.
            </td>
          </tr>
          <tr>
            <td>Server mode</td>
            <td>
              An experiment: Timelake as a database on one machine with local NVMe, compared with TimescaleDB. See SPEC
              §21.8.
            </td>
          </tr>
        </tbody>
      </table>
    </DocPage>
  )
}
