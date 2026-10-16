import { ArrowRight, ArrowUpRight } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { Suspense } from "react"

import { BenchRanking } from "@/components/bench-ranking"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { BENCHMARKS, type Benchmark } from "@/lib/benchmark-catalog"
import { latestByTarget, loadRuns, rankings, runKey, runLabel, type Run } from "@/lib/benchmarks"
import { REPO_URL } from "@/lib/site"

export const metadata: Metadata = { title: "Benchmarks" }

export default function BenchmarksPage() {
  const planned = BENCHMARKS.filter((b) => b.status === "planned")
  return (
    <div className="mx-auto max-w-6xl space-y-12 px-4 py-12">
      <header className="max-w-3xl space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">Benchmarks</h1>
        <p className="text-muted-foreground">
          Timelake against the systems a team would otherwise use for time series, on public benchmarks and our own.
          Measured with{" "}
          <Link href="/benchmarks/timebench" className="text-foreground underline underline-offset-4">
            timebench
          </Link>
          , and rerun every week.
        </p>
      </header>

      <Suspense fallback={<div className="h-96 animate-pulse rounded-xl bg-muted" />}>
        <Results />
      </Suspense>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">Coming next</h2>
        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {planned.map((b) => (
            <Link key={b.id} href={`/benchmarks/${b.id}/methodology`} className="group space-y-0.5">
              <p className="flex items-center gap-1 font-medium group-hover:underline">
                {b.name} <ArrowRight className="size-3.5 text-muted-foreground" />
              </p>
              <p className="text-sm text-muted-foreground">{b.summary}</p>
            </Link>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          The benchmarks we decided not to run, and why, are on the{" "}
          <Link href="/benchmarks/timebench#benchmarks" className="underline underline-offset-4">
            timebench page
          </Link>
          .
        </p>
      </section>
    </div>
  )
}

async function Results() {
  const runs = await loadRuns()
  return BENCHMARKS.filter((b) => b.status === "running" && b.workload).map((b) => (
    <BenchmarkResults key={b.id} benchmark={b} latest={latestByTarget(runs, b.workload ?? "")} />
  ))
}

function BenchmarkResults({ benchmark, latest }: { benchmark: Benchmark; latest: Run[] }) {
  const [first] = latest
  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="space-y-1">
            <CardTitle className="text-xl">{benchmark.name}</CardTitle>
            <CardDescription>{benchmark.summary}</CardDescription>
            {benchmark.provenance && <p className="text-xs text-muted-foreground">{benchmark.provenance}</p>}
          </div>
          <nav className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <Link href={`/benchmarks/${benchmark.id}`} className="flex items-center gap-1 hover:underline">
              All results <ArrowRight className="size-3.5" />
            </Link>
            <Link
              href={`/benchmarks/${benchmark.id}/methodology`}
              className="flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
            >
              Methodology <ArrowRight className="size-3.5" />
            </Link>
            {benchmark.origin && (
              <a
                href={benchmark.origin.url}
                className="flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
              >
                {benchmark.origin.label} <ArrowUpRight className="size-3.5" />
              </a>
            )}
          </nav>
        </div>
      </CardHeader>
      <CardContent>
        {first ? (
          <Tabs defaultValue={runKey(first)}>
            <TabsList>
              {latest.map((r) => (
                <TabsTrigger key={runKey(r)} value={runKey(r)}>
                  {runLabel(r)}
                </TabsTrigger>
              ))}
            </TabsList>
            {latest.map((r) => (
              <TabsContent key={runKey(r)} value={runKey(r)} className="space-y-5 pt-4">
                <div className="grid gap-x-10 gap-y-6 lg:grid-cols-2">
                  {rankings(r).map((ranking) => (
                    <BenchRanking key={ranking.title} ranking={ranking} />
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Run of {r.header.started.slice(0, 10)} on {r.header.machine}, commit{" "}
                  <a className="font-mono hover:underline" href={`${REPO_URL}/commit/${r.header.commit}`}>
                    {r.header.commit.slice(0, 7)}
                  </a>
                  . {r.header.variant === "bulk" ? "Higher is better." : "Lower is better."}
                  {r.queries.some((q) => q.correct !== undefined) &&
                    " Answers are checked against a copy of the data with each row once."}
                </p>
              </TabsContent>
            ))}
          </Tabs>
        ) : (
          <p className="text-sm text-muted-foreground">No runs yet.</p>
        )}
      </CardContent>
    </Card>
  )
}
