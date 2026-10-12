import Link from "next/link"
import { Code2 } from "lucide-react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

const SNIPPET = `import { Lake } from "@timelake/client"

const lake = new Lake(process.env.TIMELAKE_URL!)
const readings = lake.table("tsbs.readings")
await readings.latest({ series: [1, 2, 3] })
await readings.range({ series: 7, from: "2026-01-03T12:00:00Z", to: "2026-01-03T13:00:00Z" })
await readings.bucket({ series: 7, every: "1h", agg: { velocity: ["avg", "max"] } })`

/** Shown on hosted deploys, where the explorer reads with the WASM client instead of the engine. */
export function SqlUnavailable() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Code2 className="size-4" /> SQL runs with the Timelake engine
        </CardTitle>
        <CardDescription>
          This deployment reads the lake straight from object storage with <code className="font-mono">@timelake/client</code>, a
          WebAssembly build of the reader. It answers time-series queries (latest values, ranges, buckets) without a server-side
          engine. Arbitrary SQL needs the engine: run the explorer locally with the <code className="font-mono">timelake</code> CLI,
          or query the same tables from DuckDB.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">{SNIPPET}</pre>
        <p className="text-sm text-muted-foreground">
          See <Link className="underline underline-offset-4" href="/docs/querying">Querying</Link> and{" "}
          <Link className="underline underline-offset-4" href="/docs/quick-start">Quick start</Link>.
        </p>
      </CardContent>
    </Card>
  )
}
