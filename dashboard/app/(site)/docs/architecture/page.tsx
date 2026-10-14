import type { Metadata } from "next"
import Link from "next/link"

import { ArchitectureDiagram } from "@/components/architecture-diagram"
import { DocPage } from "@/components/docs/pager"

export const metadata: Metadata = { title: "Architecture" }

export default function Page() {
  return (
    <DocPage href="/docs/architecture">
      <h1>Architecture</h1>
      <p>
        The engine is one Rust crate (<code>timelake</code>) used by the CLI and the Python package. It builds on
        iceberg-rust’s spec types for metadata and manifests, the Rust <code>object_store</code> crate for I/O, Arrow
        and Parquet for data, and DataFusion for queries. A separate read-only WebAssembly reader (
        <code>timelake-wasm</code>, used by <code>@timelake/client</code>) shares the table rules in{" "}
        <code>timelake-format</code>. See the <Link href="/docs/codebase">Codebase tour</Link> for where each part
        lives.
      </p>
      <div className="not-prose my-6 overflow-x-auto rounded-lg border p-4">
        <div className="min-w-[720px]">
          <ArchitectureDiagram />
        </div>
      </div>

      <h2>On-disk layout</h2>
      <pre>{`<warehouse>/timelake-tables.json            list of tables, for readers that can't list objects
<warehouse>/<namespace>/<table>/
  metadata/
    v1.metadata.json … vN.metadata.json     table metadata, one per commit
    version-hint.text                       "N": the latest version (best-effort pointer)
    snap-<snapshot-id>-<uuid>.avro          manifest lists
    <uuid>-{added|merged|deleted}-m.avro    manifests
    lvi-<snapshot-id>-<uuid>.parquet        last-value index of a snapshot
  data/
    <time>_<chunk>=<label>/<uuid-v7>.parquet   e.g. time_day=2026-01-03/…
    <uuid-v7>.parquet                       plain tables (no time column) are not partitioned`}</pre>
      <p>
        This is Iceberg’s Hadoop-catalog convention, which is why DuckDB’s <code>iceberg_scan</code> can open a table
        directory directly. Tables are Iceberg format version 2.
      </p>

      <h2>Commit protocol</h2>
      <ol>
        <li>
          Load the current version: read <code>version-hint.text</code>, then read <code>vN.metadata.json</code> while
          checking whether <code>vN+1</code> already exists (the hint is written after a commit and may lag).
        </li>
        <li>Write data files, a manifest for them, the last-value index, and a new manifest list.</li>
        <li>
          Create <code>vN+1.metadata.json</code> with put-if-absent. If it already exists, another writer won: delete
          this attempt’s manifests, reload, and retry on top of the new version (up to 10 attempts, with jittered
          backoff). Data files are reused across retries.
        </li>
        <li>
          Overwrite <code>version-hint.text</code> with <code>N+1</code>.
        </li>
      </ol>
      <p>
        Appends carrying a batch id first check whether any retained snapshot already has that id; if so, the append is
        a no-op and its data files are deleted.
      </p>
      <p>
        Timelake writes its own commits rather than using iceberg-rust’s transaction API, which only supports fast
        appends. Three operations exist: <strong>append</strong>, <strong>replace</strong> (compaction: remove files,
        add files with the same rows) and <strong>delete</strong> (retention: remove files). Once a table has more than
        eight manifests, an append merges the existing ones into one, so planning a scan stays a few reads however many
        commits the table has seen.
      </p>

      <h2>Writer</h2>
      <ol>
        <li>Align each batch to the table schema by column name, casting types.</li>
        <li>
          Sort by <code>(partition, series key…, time)</code>, keeping input order for ties, and split by partition.
        </li>
        <li>
          Write each partition (eight at a time) with ZSTD level 3, page-level statistics and page indexes, 1M-row row
          groups, byte-stream-split encoding for floats, delta encoding for the time column, and the sort order recorded
          in the file. Files roll over at the target size.
        </li>
      </ol>

      <h2>Last-value index</h2>
      <p>
        On each append, the newest row of every series in the new data is merged with the previous snapshot’s index
        (later writes win on equal times) and written as a new Parquet file, referenced from the snapshot summary as{" "}
        <code>timelake.last-value-index</code>. Compaction keeps the index; retention drops series whose newest row is
        older than the cutoff. An index is only extended if it covers the whole table, so a table whose first rows were
        written by another engine has no index, and latest-row queries on it scan.
      </p>

      <h2>Compaction</h2>
      <p>
        <strong>Inline (size-tiered).</strong> After an append, small files (under ¾ of the target size) in the touched
        partitions are grouped into size tiers of 4× (under 256 KiB, 256 KiB–1 MiB, 1–4 MiB, …). A tier with at least{" "}
        <code>timelake.compact-min-files</code> files is merged into one file, which lands in a higher tier. Each row is
        rewritten about once per tier, so write amplification grows with the logarithm of the data size rather than
        linearly.
      </p>
      <p>
        <strong>Full (maintain).</strong> A partition with at least two small files, or any file not in the table’s sort
        order, is rewritten. If it has an unsorted file or holds less than twice the target size, all its files are
        rewritten into sorted files; otherwise only the small ones. Rows are merged in commit order and, with dedup on,
        the last row of each <code>(series key, time)</code> group wins. v0 merges a partition in memory, so partitions
        should fit comfortably in RAM; pick the chunk interval accordingly.
      </p>

      <h2>Snapshot expiry</h2>
      <p>
        Snapshots older than <code>timelake.snapshot-retention</code> are expired, keeping at least{" "}
        <code>timelake.min-snapshots</code> and at most <code>timelake.max-snapshots</code>. Files reachable only from
        expired snapshots (data files, manifests, manifest lists, indexes) are deleted, along with metadata files older
        than the metadata log. Inline, expiry runs in batches of about 20 snapshots.
      </p>

      <h2>Reader</h2>
      <ul>
        <li>A DataFusion catalog maps namespaces to schemas and tables to a Timelake table provider.</li>
        <li>
          Before planning, all referenced tables are loaded concurrently. Planning prunes files with DataFusion’s{" "}
          <code>PruningPredicate</code> over the Iceberg lower and upper bounds of each file.
        </li>
        <li>
          Remaining files are spread over scan partitions, footers are prefetched once per file into DataFusion’s
          metadata cache, and DataFusion’s Parquet scan does row-group and page pruning.
        </li>
        <li>
          An optimizer rule replaces the scan in latest-row query shapes with a scan of the last-value index (see
          Querying).
        </li>
      </ul>
    </DocPage>
  )
}
