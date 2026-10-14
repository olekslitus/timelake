import type { Metadata } from "next"
import Link from "next/link"

import { DocPage } from "@/components/docs/pager"

export const metadata: Metadata = { title: "Codebase tour" }

function Rows({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <table>
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r[0]}>
            {r.map((c, i) => (
              <td key={i}>{i === 0 ? <code>{c}</code> : c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const LAYOUT = [
  [
    "crates/timelake",
    "Rust",
    "The engine: storage, catalog, writer, commits, maintenance and the SQL reader. Everything else wraps or mirrors it.",
  ],
  [
    "crates/timelake-format",
    "Rust",
    "Shared rules with no I/O: the table contract (time column, series key, …), time-partition math, decoding Iceberg min/max values. Used by the engine and the WASM reader.",
  ],
  [
    "crates/timelake-cli",
    "Rust",
    "The timelake command. Parses arguments, reads CSV/Parquet, calls the engine, prints results.",
  ],
  [
    "crates/timelake-py",
    "Rust + Python",
    "The Python package. Thin bindings over the engine (PyO3), built with maturin.",
  ],
  [
    "crates/timelake-wasm",
    "Rust",
    "A small read-only engine for browsers and JavaScript, compiled to WebAssembly. It does no network I/O itself.",
  ],
  [
    "packages/timelake-client",
    "TypeScript",
    "@timelake/client: fetches files over HTTPS and hands them to the WASM reader. Rows can be typed with Zod.",
  ],
  [
    "dashboard",
    "TypeScript (Next.js)",
    "The website timelake.dev: landing page, docs, benchmark charts and the Explorer.",
  ],
  [
    "bench",
    "Python, Go, shell",
    "Benchmarks: data generators, the query runner, the v0 comparison, AWS scripts and a request-counting S3 proxy.",
  ],
  ["brand", "JavaScript", "Logo and wordmark sources and the mark editor."],
  [
    "scripts",
    "shell, JavaScript",
    "Builds the demo warehouse for the website; a static file server with Range support for testing.",
  ],
  [
    "spikes/iceberg-write",
    "Markdown",
    "Findings of an early experiment with iceberg-rust's write support (the code is in git history).",
  ],
  ["pyproject.toml", "TOML", "The uv workspace: the Python package and the benchmarks share one environment (.venv)."],
  ["SPEC.md", "Markdown", "The design: requirements, decisions, roadmap and benchmark plans."],
]

const TECH = [
  [
    "Rust 1.94",
    "Language of the engine, CLI, Python bindings and WASM reader",
    "Fast, safe, and the language of the Arrow, Parquet, Iceberg and DataFusion libraries Timelake builds on",
  ],
  [
    "Apache Arrow (arrow-rs)",
    "In-memory columns",
    "The common format between the writer, the query engine, Python and DuckDB",
  ],
  ["Apache Parquet (parquet-rs)", "Data files", "Column storage with compression and min/max statistics"],
  [
    "Apache Iceberg (iceberg-rust 0.10)",
    "Table metadata types",
    "Timelake uses its types to read and write metadata, but writes its own commits (iceberg-rust only supports simple appends)",
  ],
  ["object_store", "All file I/O", "One interface for S3, GCS, Azure, HTTP and local disk"],
  [
    "Apache DataFusion 54",
    "SQL engine",
    "Embeddable and extensible: Timelake adds a table provider and a query-rewrite rule",
  ],
  ["Tokio", "Async runtime", "Runs many storage requests in parallel"],
  [
    "PyO3 + maturin",
    "Python bindings",
    "Builds a native Python module from Rust; data crosses as Arrow without copies",
  ],
  ["wasm-bindgen", "WASM bindings", "Exposes the Rust reader to JavaScript"],
  ["TypeScript, Zod 4", "Client package", "Typed rows, validated at runtime"],
  ["Bun", "JavaScript runtime and package manager", "Installs, runs scripts and tests for the website and client"],
  ["Next.js 16, React 19", "Website", "Server-rendered pages, route handlers for the Explorer"],
  ["Tailwind CSS 4, shadcn/ui (Base UI), Recharts", "Website styling, components and charts", ""],
  [
    "Vercel, Vercel Blob",
    "Website hosting; demo data",
    "Deploys on every push to main; Blob serves the demo warehouse",
  ],
  ["Python 3.13 + uv", "Python package and benchmarks", "One uv workspace; uv.lock pins every version"],
  ["DuckDB, PyIceberg, Lance, Polars", "Benchmark competitors and helpers", ""],
  ["Go", "s3proxy", "A small proxy that counts S3 requests and signs them for AWS"],
  [
    "AWS CloudFormation, SSM",
    "Benchmark infrastructure",
    "Creates and deletes the buckets (and an optional instance) with one command",
  ],
]

export default function Page() {
  return (
    <DocPage href="/docs/codebase">
      <h1>Codebase tour</h1>
      <p>
        What lives where, which technologies are used and why, and how a write and a query flow through the code. Paths
        are relative to the repository root. For the design behind it, see <code>SPEC.md</code>; for the on-disk format,
        see <Link href="/docs/architecture">Architecture</Link>.
      </p>

      <h2>The big picture</h2>
      <pre>{`            your code
   ┌───────────┼──────────────┬──────────────────┐
   │           │              │                  │
 timelake    Python         Rust             browser / Node / serverless
  (CLI)    (timelake-py)   (use the crate)       │
   └───────────┼──────────────┘           @timelake/client (TypeScript)
               │                                 │
        crates/timelake  (the engine)     crates/timelake-wasm (read-only)
               │                                 │
               └──────── crates/timelake-format ─┘   shared rules
                                 │
                 object storage: Iceberg metadata + Parquet files`}</pre>
      <ul>
        <li>
          <strong>One engine.</strong> All writing and full SQL happen in <code>crates/timelake</code>. The CLI and the
          Python package are thin layers over it.
        </li>
        <li>
          <strong>A second, small reader for JavaScript.</strong> The engine depends on DataFusion and Tokio, which are
          too large for a browser. <code>crates/timelake-wasm</code> reimplements just the reading needed for
          time-series queries (latest values, time ranges, time buckets). The rules both must agree on live in{" "}
          <code>crates/timelake-format</code>.
        </li>
        <li>
          <strong>The website</strong> uses the client package to read the demo data, and the CLI for local SQL.
        </li>
      </ul>

      <h2>Repository layout</h2>
      <Rows head={["Path", "Language", "What it is"]} rows={LAYOUT} />

      <h2>Technologies</h2>
      <Rows head={["Technology", "Used for", "Why"]} rows={TECH} />

      <h2>The engine, file by file</h2>
      <p>
        <code>crates/timelake/src</code>, about 2,700 lines. Read them in this order:
      </p>
      <table>
        <thead>
          <tr>
            <th>File</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>lib.rs</code>
            </td>
            <td>
              The public API: <code>Lake</code>, <code>Table</code>, <code>Session</code>, options and results.
            </td>
          </tr>
          <tr>
            <td>
              <code>storage.rs</code>
            </td>
            <td>
              Opens the right object store for a URL (<code>s3://</code>, <code>gs://</code>, <code>az://</code>,{" "}
              <code>https://</code>, local). Provides read, write, <code>write_if_absent</code> (the conditional write),
              list and delete. Also adapts the store to iceberg-rust&apos;s file interface.
            </td>
          </tr>
          <tr>
            <td>
              <code>lake.rs</code>
            </td>
            <td>
              The catalog. <code>Lake</code> is a warehouse; <code>Table</code> is one version of a table.{" "}
              <code>create_table</code> writes <code>v1.metadata.json</code>; <code>table()</code> finds the current
              version (version hint, then check the next one); <code>files()</code> lists live data files from the
              manifests. Caches manifests, which never change once written.
            </td>
          </tr>
          <tr>
            <td>
              <code>write.rs</code>
            </td>
            <td>
              Turns Arrow batches into Parquet: <code>align_batch</code> (match the schema), <code>sort_and_split</code>{" "}
              (sort by partition, series, time), <code>writer_properties</code> (compression, encodings, statistics),{" "}
              <code>write_partition</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>lvi.rs</code>
            </td>
            <td>
              The last-value index: compute the newest row per series, merge it with the previous index, read and write
              it.
            </td>
          </tr>
          <tr>
            <td>
              <code>commit.rs</code>
            </td>
            <td>
              Writes manifests, the manifest list and new table metadata, then commits with <code>write_if_absent</code>
              . Retries up to 10 times when another writer wins. Three kinds of change: append, replace (compaction) and
              delete (retention).
            </td>
          </tr>
          <tr>
            <td>
              <code>ops.rs</code>
            </td>
            <td>
              The operations users call: <code>Table::append</code> (with inline maintenance) and{" "}
              <code>Table::maintain</code> (compaction with dedup, retention, snapshot expiry, file cleanup).
            </td>
          </tr>
          <tr>
            <td>
              <code>query.rs</code>
            </td>
            <td>
              The SQL reader. <code>Session</code> wraps a DataFusion context; <code>TimelakeProvider</code> plans scans
              with file pruning; <code>LatestRewrite</code> rewrites latest-row queries to read the index;{" "}
              <code>time_bucket</code> is registered here.
            </td>
          </tr>
          <tr>
            <td>
              <code>error.rs</code>
            </td>
            <td>Error types: not found, already exists, invalid input, conflict, storage, and so on.</td>
          </tr>
        </tbody>
      </table>
      <p>
        Tests: <code>crates/timelake/tests/lifecycle.rs</code> creates tables, appends, queries, maintains and checks
        results, all on local disk.
      </p>

      <h2>Follow an append through the code</h2>
      <p>
        <code>timelake append iot.readings day1.csv</code>, or <code>t.append(batch)</code> in Python, ends up in{" "}
        <code>Table::append</code> (<code>ops.rs</code>):
      </p>
      <ol>
        <li>
          <code>sort_and_split</code> (<code>write.rs</code>): match columns to the table, compute each row&apos;s day,
          sort by day, series key and time, and cut the batch into one piece per day.
        </li>
        <li>
          <code>write_partition</code> (<code>write.rs</code>): write each day&apos;s rows as Parquet under{" "}
          <code>data/time_day=…/</code>, up to eight days in parallel. Returns a description of each file (path, size,
          row count, min/max per column).
        </li>
        <li>
          <code>latest_per_series</code> (<code>lvi.rs</code>): the newest row of each series in the new data.
        </li>
        <li>
          <code>commit</code> → <code>try_commit</code> (<code>commit.rs</code>): write a manifest for the new files and
          the merged last-value index at the same time, then the manifest list, then the new metadata. With more than
          eight manifests, they are merged into one so reads stay quick.
        </li>
        <li>
          <code>publish</code> (<code>commit.rs</code>): <code>write_if_absent(vN+1.metadata.json)</code>. If the file
          already exists, another writer won: delete this attempt&apos;s metadata files, reload, and retry. On success,
          update <code>version-hint.text</code>.
        </li>
        <li>
          Back in <code>append</code>: if inline maintenance is on, run size-tiered compaction on the days this append
          touched, and expire old snapshots in batches.
        </li>
      </ol>

      <h2>Follow a query through the code</h2>
      <p>
        <code>timelake sql &quot;…&quot;</code> or <code>lake.sql(&quot;…&quot;)</code> calls <code>Session::sql</code>{" "}
        (<code>query.rs</code>):
      </p>
      <ol>
        <li>Parse the SQL and find every table it mentions.</li>
        <li>
          <code>prefetch</code>: load all those tables in parallel: metadata, manifests and the last-value index.
        </li>
        <li>
          DataFusion plans the query. It asks <code>LakeCatalog</code> → <code>NamespaceSchema</code> for each table and
          gets a <code>TimelakeProvider</code>.
        </li>
        <li>
          The optimizer runs <code>LatestRewrite</code>. If the query asks for the newest row per series (or the newest
          row for some series), the table scan is replaced with a scan of the last-value index.
        </li>
        <li>
          Otherwise <code>TimelakeProvider::scan_data</code> drops files whose min/max values can&apos;t match the{" "}
          <code>WHERE</code> clause, spreads the remaining files over parallel scan tasks, fetches every file footer
          once, and hands the files to DataFusion&apos;s Parquet reader, which skips row groups and pages.
        </li>
        <li>DataFusion runs the rest (filters, joins, aggregates) and returns Arrow batches.</li>
      </ol>

      <h2>The CLI and the Python package</h2>
      <ul>
        <li>
          <code>crates/timelake-cli/src/main.rs</code>: one file. <code>clap</code> defines the commands; CSV and
          Parquet inputs are read with DataFusion; results print as a table, CSV or JSON. Hidden flags (
          <code>--bench-runs</code>, <code>--proxy-admin</code>) exist for the benchmark runner.
        </li>
        <li>
          <code>crates/timelake-py/src/lib.rs</code>: classes <code>Lake</code> and <code>Table</code>. Each method runs
          the engine on a shared Tokio runtime and releases Python&apos;s GIL while it waits. Data comes in through the
          Arrow C stream interface, so pyarrow and polars objects work directly. Tests are in{" "}
          <code>crates/timelake-py/tests</code>.
        </li>
      </ul>

      <h2>The WebAssembly reader and the TypeScript client</h2>
      <p>
        The WASM module never makes network requests. The TypeScript client fetches bytes and hands them in, which keeps
        the module small and identical in every JavaScript runtime:
      </p>
      <ol>
        <li>
          The client fetches <code>version-hint.text</code> and <code>vN.metadata.json</code>;{" "}
          <code>new Table(json)</code> (<code>crates/timelake-wasm/src/meta.rs</code>) parses it.
        </li>
        <li>The client fetches the manifest list and manifests; the module parses them (Avro) into a list of files.</li>
        <li>
          <code>planFiles(query)</code> drops files whose min/max values can&apos;t match.
        </li>
        <li>
          For each file, the client fetches the end of the file (the footer). <code>ParquetFile.plan</code> (
          <code>query.rs</code>) returns the byte ranges of the row groups and columns needed. The client fetches just
          those ranges.
        </li>
        <li>
          <code>Query.push</code> decodes, filters and aggregates; <code>finish</code> returns JSON rows. The client
          validates them with Zod if a schema was given.
        </li>
      </ol>
      <p>
        <code>packages/timelake-client/scripts/build-wasm.sh</code> compiles the crate, shrinks it with{" "}
        <code>wasm-opt</code>, and embeds it as base64 in <code>src/wasm/inline.js</code>, so the package loads without
        a separate <code>.wasm</code> file. The generated files are committed; rebuild them after changing{" "}
        <code>crates/timelake-wasm</code>.
      </p>

      <h2>The website</h2>
      <table>
        <thead>
          <tr>
            <th>Path</th>
            <th>What</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>dashboard/app/(site)</code>
            </td>
            <td>
              Landing page, <code>/docs</code> (one folder per page) and <code>/benchmarks</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>dashboard/app/(app)/explore</code>
            </td>
            <td>The Explorer: tables, a table&apos;s details and latest values, a series chart, a SQL console.</td>
          </tr>
          <tr>
            <td>
              <code>dashboard/app/api</code>
            </td>
            <td>
              Two route handlers used by the Explorer: <code>/api/sql</code> and <code>/api/series</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>dashboard/lib/lake</code>
            </td>
            <td>
              The Explorer&apos;s data layer, with two backends behind one interface: <code>wasm.ts</code> reads a
              public warehouse with <code>@timelake/client</code> (used on timelake.dev, no SQL), <code>cli.ts</code>{" "}
              runs the <code>timelake</code> binary (local, full SQL). <code>index.ts</code> picks one by environment
              variable.
            </td>
          </tr>
          <tr>
            <td>
              <code>dashboard/lib/benchmarks.ts</code>
            </td>
            <td>
              Reads the result files in <code>dashboard/data/results</code> (a copy of the ones in{" "}
              <code>bench/results</code>, made by <code>bun run sync-results</code>) and computes the numbers for the
              charts.
            </td>
          </tr>
          <tr>
            <td>
              <code>dashboard/components</code>
            </td>
            <td>
              Page pieces (diagrams, charts, tables); <code>components/ui</code> holds shadcn/ui components.
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        Vercel builds and deploys the site on every push to <code>main</code> (project root <code>dashboard/</code>).
        The demo data on timelake.dev is a small warehouse on Vercel Blob, built by{" "}
        <code>scripts/build-demo-warehouse.sh</code> and uploaded with <code>bun run upload-demo</code>.
      </p>

      <h2>The benchmarks</h2>
      <table>
        <thead>
          <tr>
            <th>Path</th>
            <th>What</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>bench/run.py</code>
            </td>
            <td>
              Runs one query suite on one engine: each query in a fresh process, one first run plus repeats, and records
              time, rows, requests and bytes to <code>bench/results/*.jsonl</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>bench/queries</code>
            </td>
            <td>The TSBS IoT and single-truck queries, written once per engine.</td>
          </tr>
          <tr>
            <td>
              <code>bench/scripts</code>
            </td>
            <td>Data preparation: TSBS output to Parquet, Iceberg and Vortex; TimescaleDB in Docker.</td>
          </tr>
          <tr>
            <td>
              <code>bench/v0</code>
            </td>
            <td>
              The v0 comparison: <code>ingest.py</code> streams the same data into Timelake, Lance, PyIceberg and S3
              Tables; <code>run_queries.sh</code> runs the suites; <code>summarize.py</code> writes the report;{" "}
              <code>tsdb_cloud.py</code> does the same for TimescaleDB on Tiger Cloud.
            </td>
          </tr>
          <tr>
            <td>
              <code>bench/tools/s3proxy</code>
            </td>
            <td>
              Go. Sits between the engines and storage, counts requests and bytes, and can add a fixed delay. In AWS
              mode it signs requests for the real bucket.
            </td>
          </tr>
          <tr>
            <td>
              <code>bench/infra</code>
            </td>
            <td>
              AWS: one CloudFormation stack (buckets, optional instance) and scripts to create, use and delete it.
            </td>
          </tr>
          <tr>
            <td>
              <code>bench/run_*.sh</code>, <code>compare_*.py</code>
            </td>
            <td>Run whole sets of suites (Phase 0, RustFS, AWS) and print comparison tables.</td>
          </tr>
          <tr>
            <td>
              <code>bench/results</code>
            </td>
            <td>
              Raw results (<code>.jsonl</code>) and write-ups: <code>BASELINE.md</code> (Phase 0), <code>V0.md</code>,{" "}
              <code>S3.md</code>, <code>TIMESCALE.md</code>.
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        How to build and test each part is on <Link href="/docs/development">Development</Link>.
      </p>
    </DocPage>
  )
}
