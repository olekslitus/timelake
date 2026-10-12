import type { Metadata } from "next"
import Link from "next/link"

import { DocPage } from "@/components/docs/pager"

export const metadata: Metadata = { title: "Introduction" }

export default function Page() {
  return (
    <DocPage href="/docs">
      <h1>Introduction</h1>
      <p>
        Timelake is a time-series store on Apache Iceberg. It writes ordinary Iceberg tables with Parquet data files to object
        storage (S3 and S3-compatible stores, Google Cloud Storage, Azure Blob Storage) or a local directory, keeps them laid
        out for time-series queries, and reads them with a query engine that uses that layout.
      </p>
      <p>
        It is a Rust library with a command-line tool (<code>timelake</code>) and a Python package. There is no server: the
        catalog is files in the warehouse, commits are atomic through conditional writes, and maintenance runs inside the
        writer or as one stateless command.
      </p>

      <h2>What it does</h2>
      <ul>
        <li>
          <strong>Time-series tables.</strong> You declare a time column and a series key (such as <code>device_id</code>),
          like a TimescaleDB hypertable. Data is partitioned by hour, day or month and every file is sorted by
          <code>(series key, time)</code>.
        </li>
        <li>
          <strong>Streaming-friendly writes.</strong> Each append is one atomic Iceberg snapshot. Retries can be made
          idempotent with a batch id, and concurrent writers are safe.
        </li>
        <li>
          <strong>Built-in maintenance.</strong> Small files from frequent appends are compacted inline, duplicates are removed
          (the latest write wins), old data is dropped by retention, and old snapshots are expired.
        </li>
        <li>
          <strong>Fast latest values.</strong> A last-value index holds the newest row of every series; queries for the latest
          row are rewritten to read it.
        </li>
        <li>
          <strong>Open format.</strong> Plain DuckDB reads Timelake tables with <code>iceberg_scan</code>; no Timelake
          software is needed to read.
        </li>
      </ul>

      <h2>When to use it</h2>
      <p>
        Timelake targets telemetry and other append-heavy time series (IoT and industrial data first) where object storage is
        the system of record and you would otherwise run S3 Tables or self-managed Iceberg plus scheduled compaction jobs. It
        is not an OLTP database; the freshest data is visible at commit granularity (each append), not per row.
      </p>

      <h2>Status</h2>
      <p>
        This is v0, a private preview. It covers the write path, maintenance and the reader. A REST catalog, a hot tier for
        sub-commit freshness, deletes and GDPR erasure, and continuous aggregates are planned; see{" "}
        <Link href="/docs/roadmap">Roadmap & limitations</Link>.
      </p>
      <p>
        Next: <Link href="/docs/quick-start">Quick start</Link>.
      </p>
    </DocPage>
  )
}
