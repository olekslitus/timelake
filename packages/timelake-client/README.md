# @timelake/client

Read and append to [Timelake](https://timelake.dev) tables from the browser, Node, Bun, Cloudflare Workers, or serverless functions. A
WebAssembly build of Timelake's reader parses the Iceberg metadata, prunes files and row groups, decodes Parquet
and computes aggregates; the package fetches only the byte ranges it needs. No server, no query engine to run.
Rows can be validated and typed with Zod.

```bash
npm install @timelake/client zod
```

```ts
import { z } from "zod"
import { Lake } from "@timelake/client"

const Reading = z.object({ time: z.coerce.date(), tags_id: z.number().int(), velocity: z.number().nullable() })
const lake = new Lake("https://<store>.public.blob.vercel-storage.com/demo")
const readings = lake.table("tsbs.readings", Reading)

await readings.latest({ series: [1, 2, 3] })        // newest row per series
await readings.range({ series: 7, from: "2026-01-03T12:00:00Z", to: "2026-01-03T13:00:00Z" })
await readings.bucket({ series: 7, every: "1h", agg: { velocity: ["avg", "max"] } })
```

Append to tables, from Cloudflare Workers too (the WebAssembly module runs the engine's write path and compaction):

```ts
import wasm from "@timelake/client/timelake.wasm"
import { TableWriter, initWasm, r2Store } from "@timelake/client/workers"

initWasm(wasm)
const writer = new TableWriter(r2Store(env.LAKE), "s3://my-bucket/lake", "iot.readings")
await writer.append([{ time: new Date(), device: 7, temp: 21.5 }])
```

- Docs: [timelake.dev/docs/typescript](https://timelake.dev/docs/typescript)
- Source: [github.com/polythings/timelake](https://github.com/polythings/timelake/tree/main/packages/timelake-client)

Licensed under the Apache License 2.0.
