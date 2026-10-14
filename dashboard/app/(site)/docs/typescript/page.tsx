import type { Metadata } from "next"

import { DocPage } from "@/components/docs/pager"

export const metadata: Metadata = { title: "TypeScript client" }

export default function Page() {
  return (
    <DocPage href="/docs/typescript">
      <h1>TypeScript client</h1>
      <p>
        <code>@timelake/client</code> reads Timelake tables over HTTPS from the browser, Node, Bun, or serverless
        functions. A WebAssembly build of Timelake&apos;s reader (<code>crates/timelake-wasm</code>) parses the Iceberg
        metadata, prunes files and row groups, decodes Parquet, and computes aggregates. The package only fetches the
        byte ranges the reader asks for. There is no server and no query engine to run. Rows can be validated and typed
        with Zod.
      </p>
      <pre>{`import { z } from "zod"
import { Lake } from "@timelake/client"

const Reading = z.object({
  time: z.coerce.date(),          // times arrive as ISO strings
  tags_id: z.number().int(),
  velocity: z.number().nullable(),
})

const lake = new Lake("https://<store>.public.blob.vercel-storage.com/demo")
const readings = lake.table("tsbs.readings", Reading)

await readings.latest({ series: [1, 2, 3] })        // newest row per truck (last-value index)
await readings.range({ series: 7, from: "2026-01-03T12:00:00Z", to: "2026-01-03T13:00:00Z" })
const hourly = await readings.bucket({
  series: 7, every: "1h",
  agg: { velocity: ["avg", "max"], "*": ["count"] },
})
hourly[0].velocity_avg                               // number | null, typed from the agg map`}</pre>

      <h2>Install</h2>
      <p>
        The package isn&apos;t published to npm yet. Inside this repository it is a bun workspace package, so other
        workspace packages (like the website) depend on it with{" "}
        <code>&quot;@timelake/client&quot;: &quot;workspace:*&quot;</code>. It needs <code>zod</code> 4 as a peer
        dependency.
      </p>

      <h2>What it reads</h2>
      <p>
        A warehouse served over plain HTTP(S), such as Vercel Blob, a public S3, R2 or GCS bucket, or a CDN. The server
        must support <code>Range</code> requests (it then answers <code>206</code>); without them the client downloads
        whole files and still returns correct results. A plain HTTP server can&apos;t list files, so the client finds
        tables through the warehouse&apos;s <code>timelake-tables.json</code>, which the writer maintains (
        <code>timelake index</code> rewrites it).
      </p>

      <h2>API</h2>
      <table>
        <thead>
          <tr>
            <th>Call</th>
            <th>Returns</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>new Lake(url, {"{ fetch?, concurrency?, cacheMs?, rewriteUrl? }"})</code>
            </td>
            <td>
              A warehouse handle. <code>concurrency</code> caps parallel requests (default 16). <code>cacheMs</code>{" "}
              controls how long a loaded table version is reused (default 5000). <code>rewriteUrl</code> maps object
              URLs when a warehouse has moved.
            </td>
          </tr>
          <tr>
            <td>
              <code>lake.tables()</code>
            </td>
            <td>
              <code>string[]</code> of <code>namespace.table</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>lake.table(name, schema?)</code>
            </td>
            <td>
              A table handle. Rows are typed and validated with the Zod schema if one is given; otherwise they are{" "}
              <code>Record&lt;string, unknown&gt;</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>table.latest({"{ series?, columns? }"})</code>
            </td>
            <td>
              The newest row of each series, read from the last-value index in a single request. Throws if the table has
              no index.
            </td>
          </tr>
          <tr>
            <td>
              <code>table.range({"{ series?, from?, to?, columns?, limit?, order? }"})</code>
            </td>
            <td>
              Rows in <code>[from, to)</code>, ordered by time. <code>columns</code> narrows the result type to those
              columns.
            </td>
          </tr>
          <tr>
            <td>
              <code>table.bucket({"{ series?, from?, to?, every, agg, by? }"})</code>
            </td>
            <td>
              One row per bucket (and per <code>by</code> value): <code>bucket: Date</code> plus{" "}
              <code>{"<column>_<op>"}</code> for each aggregate (<code>count</code>, <code>sum</code>, <code>avg</code>,{" "}
              <code>min</code>, <code>max</code>, <code>first</code>, <code>last</code>);{" "}
              <code>&quot;*&quot;: [&quot;count&quot;]</code> gives <code>count</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>table.info()</code>
            </td>
            <td>Contract, schema, snapshots and live files of the current version.</td>
          </tr>
          <tr>
            <td>
              <code>table.zodSource()</code>
            </td>
            <td>The TypeScript source of a Zod schema for the table, ready to paste.</td>
          </tr>
          <tr>
            <td>
              <code>table.refresh()</code>
            </td>
            <td>Forget the cached table version, so the next query reads the newest one.</td>
          </tr>
          <tr>
            <td>
              <code>zodSource(info, exportName?)</code>, <code>readerVersion()</code>
            </td>
            <td>
              Standalone exports: generate Zod source from a <code>table.info()</code> result; the version of the
              embedded WASM reader.
            </td>
          </tr>
          <tr>
            <td>
              <code>table.lastStats</code>
            </td>
            <td>Requests, bytes, files and milliseconds of the last query.</td>
          </tr>
        </tbody>
      </table>
      <p>
        <code>series</code> is a value or a list of values of the first series-key column, or an object such as{" "}
        <code>{'{ device_id: ["a", "b"] }'}</code>. Times are <code>Date</code> objects, ISO strings, or epoch
        milliseconds. Durations are written like <code>500ms</code>, <code>30s</code>, <code>10m</code>, <code>1h</code>
        , <code>1d</code> or <code>1w</code>, or given as a number of milliseconds. Buckets are aligned to the Unix
        epoch.
      </p>

      <h2>How a query runs</h2>
      <ol>
        <li>
          Read <code>version-hint.text</code>, then the table metadata, the manifest list, and the manifests. These are
          cached per table handle for <code>cacheMs</code>.
        </li>
        <li>Prune data files on their Iceberg column bounds (time range, series key).</li>
        <li>
          For each remaining file, fetch the Parquet footer, then only the row groups and columns the query needs.
        </li>
        <li>
          Decode, filter, and sort or aggregate in WebAssembly, and return JSON rows (validated with Zod if given).
        </li>
      </ol>

      <h2>Limits</h2>
      <ul>
        <li>It is a reader: writes go through the CLI, the Python package, or the Rust library.</li>
        <li>
          It answers time-series query shapes, not arbitrary SQL. For SQL, use the engine (CLI, Python) or plain DuckDB.
        </li>
        <li>
          The WASM module is embedded as base64, about 8 MB of JavaScript (about 2 MB gzipped). That is fine on servers;
          in browsers, load it lazily.
        </li>
        <li>
          Pruning works at the row-group level. Tables meant for web reads should use smaller row groups (the demo uses{" "}
          <code>timelake.row-group-rows=65536</code>).
        </li>
        <li>
          <strong>Known issue:</strong> a <code>range</code> or <code>bucket</code> query that needs 16 or more files
          waits forever with the default <code>concurrency</code> of 16. Until it is fixed, set <code>concurrency</code>{" "}
          higher than the number of files a query can touch, or run <code>timelake maintain</code> so tables have fewer
          files.
        </li>
      </ul>
    </DocPage>
  )
}
