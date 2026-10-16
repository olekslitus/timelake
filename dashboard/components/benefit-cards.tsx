import { Activity, ArrowRight, Cloud, Gauge, Layers, PiggyBank, ServerOff, type LucideIcon } from "lucide-react"
import Link from "next/link"
import type { ReactNode } from "react"

import { BarChart, type BarRow } from "@/components/bar-chart"
import { CostCalculator } from "@/components/cost-calculator"
import { MoveOut } from "@/components/move-out"
import { type ArtKind, UseCaseArt } from "@/components/use-case-art"
import { latestByTarget, loadRuns, rankings, type Run } from "@/lib/benchmarks"
import { cn } from "@/lib/utils"

type Card = {
  icon: LucideIcon
  title: string
  body: string
  link: { label: string; href: string }
  /** Columns the card spans on a wide screen (of 4). */
  span?: 1 | 2 | 4
} & ({ art: ArtKind; figure?: ReactNode } | { art?: never; figure: ReactNode })

/** The value at percentile `p` (0..1) of `values`, by nearest rank. */
const percentile = (values: number[], p: number) => {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0
}

const ms = (seconds: number) => `${Math.round(seconds * 1000)} ms`

/**
 * Timelake's query times in a weekly S3 run: p50, p90, and p99 after maintenance, warm (the mean of each query's repeats
 * in the same process) over cold (its first run, in a fresh process), and how much faster it is than the other lakes.
 */
function speed(run: Run | undefined): { body: string; rows: BarRow[] | null } {
  const ranked = run ? rankings(run) : []
  const ingested = ranked.find((r) => r.title.startsWith("Queries, right"))?.rows ?? []
  const own = ingested.find((r) => r.timelake)
  const others = ingested.filter((r) => r.system !== "timelake").map((r) => r.value)
  const queries = (run?.queries ?? []).filter(
    (q) => q.system === "timelake" && q.reader === "timelake" && q.checkpoint === "maintained" && q.status === "ok",
  )
  if (!own || others.length === 0 || queries.length === 0)
    return { body: "Measured every week against other lakes on S3.", rows: null }
  const x = (v: number) => Math.round(v / own.value)
  const range = `${x(Math.min(...others))}⁠–⁠${x(Math.max(...others))}×`
  const cold = queries.map((q) => q.times[0])
  const warm = queries.map((q) => {
    const repeats = q.times.slice(1)
    return repeats.length > 0 ? repeats.reduce((a, b) => a + b, 0) / repeats.length : q.times[0]
  })
  return {
    body: `Query times on S3 over ${queries.length} TSBS IoT queries, and ${range} faster than other lakes on fresh data.`,
    rows: [0.5, 0.9, 0.99].map((p) => {
      const [w, c] = [percentile(warm, p), percentile(cold, p)]
      return {
        label: `p${Math.round(p * 100)}`,
        bars: [
          { value: w, color: "var(--chart-4)", text: ms(w) },
          { value: c, color: "var(--primary)", text: ms(c), strong: true },
        ],
      }
    }),
  }
}

/** Columns in a wide card's picture, twice a narrow one's. */
const WIDE_COLS = 128
/** Each span's columns: two of the grid's two on a tablet, and its own share of four on a wide screen. */
const SPANS = { 1: "", 2: "md:col-span-2", 4: "md:col-span-2 lg:col-span-4" }

export async function BenefitCards() {
  const run = latestByTarget(await loadRuns(), "tsbs-iot").find(
    (r) => r.header.target === "aws-s3" && !r.header.variant,
  )
  const fast = speed(run)
  // Fast and Cheap on top; Open, Analytics, and Serverless; then Any object store across the width.
  const cards: Card[] = [
    {
      icon: Gauge,
      art: "fast",
      title: "Fast",
      body: fast.body,
      link: { label: "Benchmarks", href: "/benchmarks" },
      span: 2,
      figure: fast.rows && (
        <BarChart
          rows={fast.rows}
          legend={[
            { label: "Warm: a repeat in the same process", color: "var(--chart-4)" },
            { label: "Cold: the first run, in a fresh process", color: "var(--primary)" },
          ]}
        />
      ),
    },
    {
      icon: PiggyBank,
      title: "Cheap",
      body: "You pay only for storage, reads, and writes. There’s no database server to keep running.",
      link: { label: "Cost", href: "/docs/storage#requests-and-cost" },
      span: 2,
      figure: <CostCalculator />,
    },
    {
      icon: Layers,
      title: "Open",
      body: "Tables are standard Iceberg and Parquet in your own bucket, so you’re not locked in: DuckDB and Spark read them too.",
      link: { label: "Querying", href: "/docs/querying" },
      span: 2,
      figure: <MoveOut />,
    },
    {
      icon: Activity,
      art: "layout",
      title: "Analytics",
      body: "Data is laid out by time and series, so queries read only what they need.",
      link: { label: "Performance", href: "/docs/performance" },
    },
    {
      icon: ServerOff,
      art: "serverless",
      title: "Serverless",
      body: "No database or maintenance jobs to run. Timelake is a library that runs in your process.",
      link: { label: "How it works", href: "/docs/how-it-works" },
    },
    {
      icon: Cloud,
      art: "stores",
      title: "Any object store",
      body: "Runs on AWS S3, Google Cloud Storage, Azure, R2, MinIO, or your local disk.",
      link: { label: "Storage", href: "/docs/storage" },
      span: 4,
    },
  ]
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {cards.map((c) => {
        const Icon = c.icon
        return (
          <div
            key={c.title}
            data-use-case
            className={cn("flex flex-col gap-2 rounded-lg border bg-card p-6", SPANS[c.span ?? 1])}
          >
            <h3 className="flex items-center gap-2.5 text-lg font-normal">
              <Icon className="size-4.5 text-muted-foreground" aria-hidden />
              {c.title}
            </h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{c.body}</p>
            {/* Pinned to the bottom, so pictures line up across a row. */}
            <div className="mt-auto pt-4">
              {c.figure ?? (c.art && <UseCaseArt kind={c.art} cols={(c.span ?? 1) > 1 ? WIDE_COLS : undefined} />)}
            </div>
            <Link
              href={c.link.href}
              {...(c.link.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
              className="flex w-fit items-center gap-1.5 pt-2 text-sm hover:underline"
            >
              {c.link.label} <ArrowRight className="size-3.5" />
            </Link>
          </div>
        )
      })}
    </div>
  )
}
