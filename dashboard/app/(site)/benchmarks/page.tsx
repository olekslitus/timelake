import { ArrowRight } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { Suspense } from "react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { WORKLOADS, latestByTarget, loadRuns, panels, targetLabel } from "@/lib/benchmarks"
import { formatSeconds } from "@/lib/format"
import { PUBLIC_BENCHMARKS, type PublicBenchmark } from "@/lib/public-benchmarks"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Benchmarks" }

const PLANNED = [
  {
    title: "Industrial IoT",
    description:
      "Plant data as it really arrives: 100,000+ tags at mixed rates, gateways that go offline and backfill, vibration bursts. Measured as data grows from a day to a month.",
  },
  {
    title: "AI agents",
    description:
      "An AI agent answers questions about the data through tools, with answers known in advance. Is it right more often, and cheaper, when the data is in Timelake?",
  },
]

const STATUS: Record<PublicBenchmark["status"], { label: string; variant: "default" | "secondary" | "outline" }> = {
  running: { label: "Running", variant: "default" },
  planned: { label: "Planned", variant: "secondary" },
  "not planned": { label: "Not planned", variant: "outline" },
}

export default function BenchmarksPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-14 px-4 py-12">
      <header className="max-w-3xl space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">Benchmarks</h1>
        <p className="text-muted-foreground">
          How does Timelake compare with what a team would otherwise use for time series: other table formats on object
          storage, and a time-series database? Every run is kept, so you can see how the numbers move as Timelake
          changes.
        </p>
      </header>

      <section className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Same data, same queries</CardTitle>
            <CardDescription>
              Each workload replays data the way it arrives, in small batches, into every system. Each system is written
              and read the way its own docs suggest.
            </CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Before and after cleanup</CardTitle>
            <CardDescription>
              Queries run right after ingest, which is what readers see until compaction runs, and again after each
              system&apos;s own maintenance.
            </CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Every run kept</CardTitle>
            <CardDescription>
              Each run records the commit, the machine and every version. A weekly run on a fixed AWS machine adds a
              point to the history.
            </CardDescription>
          </CardHeader>
        </Card>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">Workloads</h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Suspense fallback={<div className="h-40 animate-pulse rounded-xl bg-muted" />}>
            <WorkloadCards />
          </Suspense>
          {PLANNED.map((p) => (
            <Card
              key={p.title}
              className="bg-transparent ring-0 outline-1 -outline-offset-1 outline-border outline-dashed"
            >
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <CardTitle>{p.title}</CardTitle>
                  <Badge variant="outline">Planned</Badge>
                </div>
                <CardDescription>{p.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <div className="max-w-3xl space-y-1">
          <h2 className="text-xl font-semibold tracking-tight">Public benchmarks</h2>
          <p className="text-sm text-muted-foreground">
            The published benchmarks for time-series data that we know of, and why each has results here or not.
          </p>
        </div>
        <Card>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Benchmark</TableHead>
                  <TableHead>What it measures</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Why</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {PUBLIC_BENCHMARKS.map((b) => (
                  <TableRow key={b.name}>
                    <TableCell className="font-medium whitespace-nowrap">
                      <a href={b.url} className="hover:underline" target="_blank" rel="noreferrer">
                        {b.name}
                      </a>
                    </TableCell>
                    <TableCell className="min-w-48 whitespace-normal text-muted-foreground">{b.measures}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS[b.status].variant}>{STATUS[b.status].label}</Badge>
                    </TableCell>
                    <TableCell className="min-w-64 whitespace-normal text-muted-foreground">{b.why}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>

      <section className="max-w-3xl space-y-3 text-sm text-muted-foreground">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">How to read the numbers</h2>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>
            Each query runs in a fresh process: a first run, which loads metadata and data, then repeats. Charts show
            the first run, the latency a new dashboard or job sees.
          </li>
          <li>
            Times are geometric means over the queries every system completed, so one slow query doesn&apos;t hide the
            rest. Row counts are checked to match across systems.
          </li>
          <li>
            On S3, every request goes through a proxy that counts requests and bytes, which is what object storage bills
            for.
          </li>
          <li>
            A database server keeps data in memory between queries, so its &quot;first run&quot; is warmer than a fresh
            reader on object storage.
          </li>
          <li>
            Each workload page shows the machine and versions of every run. The code is in{" "}
            <code className="font-mono">bench/</code>; anyone can rerun it.
          </li>
        </ul>
      </section>
    </div>
  )
}

async function WorkloadCards() {
  const runs = await loadRuns()
  return WORKLOADS.map((w) => {
    const latest = latestByTarget(runs, w.id)
    const run = latest.find((r) => r.header.target === "aws-s3") ?? latest[0]
    const panel = run && panels(run, w).find((p) => p.suite === w.suites[0].id && p.state === "After maintenance")
    const timelake = panel?.bars.find((b) => b.timelake)
    const others = panel?.bars.filter((b) => !b.timelake).sort((a, b) => a.first - b.first) ?? []
    const count = runs.filter((r) => r.header.workload === w.id).length
    return (
      <Link key={w.id} href={`/benchmarks/${w.id}`} className="group">
        <Card className="h-full transition-colors group-hover:bg-muted/40">
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <CardTitle>{w.title}</CardTitle>
              <Badge>Running</Badge>
            </div>
            <CardDescription>{w.summary}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {timelake && others[0] && run && (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  {targetLabel(run.header.target)}, after maintenance, first run
                </p>
                <p className="font-mono tabular-nums">
                  <span className="font-semibold">Timelake {formatSeconds(timelake.first)}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · next {formatSeconds(others[0].first)} ({others[0].label})
                  </span>
                </p>
              </div>
            )}
            <p className={cn("flex items-center gap-1 text-muted-foreground group-hover:text-foreground")}>
              {count} {count === 1 ? "run" : "runs"} · results and history <ArrowRight className="size-3.5" />
            </p>
          </CardContent>
        </Card>
      </Link>
    )
  })
}
