import { ArrowRight, ArrowUpRight, ChevronLeft } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Suspense } from "react"

import { BenchCharts } from "@/components/bench-charts"
import { BenchHistory } from "@/components/bench-history"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { BENCHMARKS, benchmark } from "@/lib/benchmark-catalog"
import {
  SYSTEMS,
  SYSTEM_COLORS,
  WORKLOADS,
  engineLabel,
  failures,
  history,
  latestByTarget,
  loadRuns,
  panels,
  s3TablesDelay,
  targetLabel,
  type Run,
  type Workload,
} from "@/lib/benchmarks"
import { formatBytes, formatNumber } from "@/lib/format"
import { REPO_URL } from "@/lib/site"

type Props = { params: Promise<{ id: string }> }

/** Benchmarks with results; the others have only a methodology page. */
const withResults = () => BENCHMARKS.filter((b) => b.workload && WORKLOADS.some((w) => w.id === b.workload))

export function generateStaticParams() {
  return withResults().map((b) => ({ id: b.id }))
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const b = benchmark((await params).id)
  return { title: b ? `${b.name} results` : "Benchmarks" }
}

export default async function BenchmarkPage({ params }: Props) {
  const b = benchmark((await params).id)
  const workload = WORKLOADS.find((w) => w.id === b?.workload)
  if (!b || !workload) notFound()
  return (
    <div className="mx-auto max-w-6xl space-y-12 px-4 py-12">
      <header className="max-w-3xl space-y-3">
        <Link
          href="/benchmarks"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" /> Benchmarks
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">{b.name}</h1>
        <p className="text-muted-foreground">{b.summary}</p>
        <nav className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <Link href={`/benchmarks/${b.id}/methodology`} className="flex items-center gap-1 hover:underline">
            Methodology <ArrowRight className="size-3.5" />
          </Link>
          {b.origin && (
            <a
              href={b.origin.url}
              className="flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
            >
              {b.origin.label} <ArrowUpRight className="size-3.5" />
            </a>
          )}
        </nav>
      </header>

      <Suspense fallback={<div className="h-96 animate-pulse rounded-xl bg-muted" />}>
        <Results workload={workload} />
      </Suspense>
    </div>
  )
}

async function Results({ workload }: { workload: Workload }) {
  const runs = await loadRuns()
  const latest = latestByTarget(runs, workload.id)
  const [first] = latest
  if (!first) return <p className="text-sm text-muted-foreground">No runs yet.</p>
  const all = runs.filter((r) => r.header.workload === workload.id).toReversed()
  return (
    <>
      <section className="space-y-4">
        <div className="max-w-3xl">
          <h2 className="text-xl font-semibold tracking-tight">Latest results</h2>
          <p className="text-sm text-muted-foreground">
            The newest run on each kind of storage. Timelake&apos;s own reader in blue; the multiplier is relative to
            the fastest.
          </p>
        </div>
        <Tabs defaultValue={first.header.target}>
          <TabsList>
            {latest.map((r) => (
              <TabsTrigger key={r.header.target} value={r.header.target}>
                {targetLabel(r.header.target)}
              </TabsTrigger>
            ))}
          </TabsList>
          {latest.map((r) => (
            <TabsContent key={r.header.target} value={r.header.target} className="space-y-6 pt-4">
              <RunResults run={r} workload={workload} />
            </TabsContent>
          ))}
        </Tabs>
      </section>

      <section className="space-y-4">
        <div className="max-w-3xl">
          <h2 className="text-xl font-semibold tracking-tight">Over time</h2>
          <p className="text-sm text-muted-foreground">
            Each system&apos;s own reader after maintenance: the geometric mean of first runs over the queries it
            completed in each run. The weekly run adds a point every Monday.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {latest.map((r) => {
            const h = history(runs, workload.id, r.header.target, "maintained")
            return (
              <Card key={r.header.target}>
                <CardHeader>
                  <CardTitle className="text-base">{targetLabel(r.header.target)}</CardTitle>
                  <CardDescription>
                    {h.points.length} {h.points.length === 1 ? "run" : "runs"}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <BenchHistory
                    lines={h.engines.map((e) => ({
                      engine: e,
                      label: engineLabel(e),
                      color: SYSTEM_COLORS[e.split("+", 1)[0] ?? ""] ?? "var(--chart-2)",
                    }))}
                    rows={h.points}
                  />
                </CardContent>
              </Card>
            )
          })}
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">All runs</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Storage</TableHead>
                  <TableHead>Machine</TableHead>
                  <TableHead>Commit</TableHead>
                  <TableHead>Systems</TableHead>
                  <TableHead>Record</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {all.map((r) => (
                  <TableRow key={r.header.id}>
                    <TableCell className="font-mono whitespace-nowrap tabular-nums">
                      {r.header.started.slice(0, 10)}
                    </TableCell>
                    <TableCell>{targetLabel(r.header.target)}</TableCell>
                    <TableCell className="min-w-48 whitespace-normal text-muted-foreground">
                      {r.header.machine}
                    </TableCell>
                    <TableCell>
                      <a className="font-mono hover:underline" href={`${REPO_URL}/commit/${r.header.commit}`}>
                        {r.header.commit.slice(0, 7)}
                      </a>
                    </TableCell>
                    <TableCell className="min-w-48 whitespace-normal text-muted-foreground">
                      {Object.keys(r.header.readers)
                        .map((s) => SYSTEMS[s] ?? s)
                        .join(", ")}
                    </TableCell>
                    <TableCell>
                      <a
                        className="font-mono text-xs hover:underline"
                        href={`${REPO_URL}/blob/main/bench/results/runs/${r.header.id}.jsonl`}
                      >
                        {r.header.label === "weekly" ? "weekly" : "jsonl"}
                      </a>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>
    </>
  )
}

function RunResults({ run, workload }: { run: Run; workload: Workload }) {
  const h = run.header
  const delay = s3TablesDelay(run)
  const failed = failures(run)
  const ingest = run.phases.filter((p) => p.kind === "ingest")
  const maintain = new Map(run.phases.filter((p) => p.kind === "maintain").map((p) => [p.system, p]))
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span className="font-mono tabular-nums">{h.started.slice(0, 10)}</span>
        <span>{h.machine}</span>
        <a className="font-mono hover:underline" href={`${REPO_URL}/commit/${h.commit}`}>
          {h.commit.slice(0, 7)}
        </a>
        {h.imported && <Badge variant="outline">from the v0 scripts</Badge>}
        <span className="font-mono text-xs">
          {Object.entries(h.versions)
            .map(([name, v]) => `${name} ${v}`)
            .join(" · ")}
        </span>
      </div>

      <BenchCharts panels={panels(run, workload)} suites={workload.suites} />
      {delay && (
        <p className="text-sm text-muted-foreground">
          S3 Tables compacted {delay[0].toFixed(1)}–{delay[1].toFixed(1)} hours after ingest; until then its readers see
          the &quot;right after ingest&quot; numbers.
        </p>
      )}

      {ingest.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Ingest and maintenance</CardTitle>
            <CardDescription>
              Storage is all files after maintenance; replaced files still waiting for cleanup count too.
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>System</TableHead>
                  <TableHead className="text-right">Ingest</TableHead>
                  <TableHead className="text-right">Commit p50</TableHead>
                  <TableHead className="text-right">Commit p95</TableHead>
                  <TableHead className="text-right">Maintenance</TableHead>
                  <TableHead className="text-right">Files</TableHead>
                  <TableHead className="text-right">Storage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ingest.map((p) => {
                  const m = maintain.get(p.system)
                  const after = m ?? p
                  return (
                    <TableRow key={p.system}>
                      <TableCell className={p.system === "timelake" ? "font-medium" : undefined}>
                        {SYSTEMS[p.system] ?? p.system}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{seconds(p.seconds)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{ms(p.commit_ms_p50)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{ms(p.commit_ms_p95)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {p.system === "s3tables" ? "managed" : seconds(m?.seconds)}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {after.data_files == null ? "—" : formatNumber(after.data_files)}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {after.bytes == null ? "—" : formatBytes(after.bytes)}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {failed.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Failed and left out of the charts:{" "}
          {failed
            .map(
              (f) => `${f.engine} ${f.query} (${f.checkpoint === "ingested" ? "after ingest" : "after maintenance"})`,
            )
            .join(", ")}
          .
        </p>
      )}
    </>
  )
}

const seconds = (s: number | undefined) =>
  s == null ? "—" : s < 100 ? `${s.toFixed(1)} s` : s < 600 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`
const ms = (v: number | undefined) => (v == null ? "—" : `${Math.round(v)} ms`)
