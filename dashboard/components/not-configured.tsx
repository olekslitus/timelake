import Link from "next/link"
import { DatabaseZap } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

/** Shown when the explorer has no lake to read here (e.g. on a hosted deploy without the CLI). */
export function NotConfigured({ detail }: { detail?: string }) {
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <div className="mb-2 flex size-9 items-center justify-center rounded-lg bg-muted">
          <DatabaseZap className="size-4 text-muted-foreground" />
        </div>
        <CardTitle>The explorer is not connected to a lake here</CardTitle>
        <CardDescription>
          The explorer reads tables through the <code className="font-mono">timelake</code> CLI. That needs the binary and a
          warehouse on this machine, which hosted deployments don&apos;t have yet. Hosted reading through a WASM build of the
          reader is in progress.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="space-y-1.5">
          <p className="font-medium">To run it locally</p>
          <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs leading-6">
            {`cargo build --release -p timelake-cli     # from the repo root
cd dashboard && bun run dev               # http://127.0.0.1:3000/explore`}
          </pre>
          <p className="text-muted-foreground">
            Point it at a warehouse with <code className="font-mono">TIMELAKE_WAREHOUSE</code> (a local path or{" "}
            <code className="font-mono">s3://…</code>) and, if the binary lives elsewhere,{" "}
            <code className="font-mono">TIMELAKE_BIN</code>.
          </p>
        </div>
        {detail && <p className="font-mono text-xs text-muted-foreground">{detail}</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" render={<Link href="/docs/quick-start" />}>
            Quick start
          </Button>
          <Button variant="outline" size="sm" render={<Link href="/benchmarks" />}>
            Benchmarks
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
