import { Activity, ArrowRight, Cloud, Gauge, Layers, PiggyBank, ServerOff, type LucideIcon } from "lucide-react"
import Link from "next/link"
import type { ReactNode } from "react"

import { BarChart, type BarRow } from "@/components/bar-chart"
import { type ArtKind, UseCaseArt } from "@/components/use-case-art"
import { latestByTarget, loadRuns, rankings, type Run } from "@/lib/benchmarks"
import { cn } from "@/lib/utils"

type Card = {
  icon: LucideIcon
  art: ArtKind
  title: string
  body: string
  link: { label: string; href: string }
  wide?: boolean
  /** Rows in the picture, for a card next to a taller one. */
  rows?: number
  /** A chart shown instead of the picture. */
  figure?: ReactNode
}

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

/** Prices for keeping data a month (October 2026): S3 Standard, and Tiger Cloud's Performance plan. */
const S3_GB_MONTH = 0.023
const TIGER_COMPUTE_MONTH = 30
const TIGER_GB_MONTH = 0.177
/** Timelake's Parquet for the same data, as a share of TimescaleDB's columnstore (228 MB to 413 MB, TSBS IoT). */
const PARQUET_SHARE = 228 / 413

const usd = (v: number) => (v < 10 ? `$${v.toFixed(2)}` : `$${Math.round(v).toLocaleString("en")}`)

/**
 * Keeping the same data a month, by its size in TimescaleDB: Timelake's Parquet on S3 in green, and a Tiger Cloud
 * service (its smallest compute plus storage) in grey. Reads and writes are left out.
 */
function keepingCost(): BarRow[] {
  return [
    ["10 GB", 10],
    ["100 GB", 100],
    ["1 TB", 1000],
  ].map(([label, gb]) => {
    const size = Number(gb)
    const [lake, tiger] = [size * PARQUET_SHARE * S3_GB_MONTH, TIGER_COMPUTE_MONTH + size * TIGER_GB_MONTH]
    return {
      label: String(label),
      bars: [
        { value: lake, color: "var(--chart-3)", text: usd(lake), strong: true },
        { value: tiger, color: "var(--muted-foreground)", text: usd(tiger) },
      ],
    }
  })
}

/** Columns in a wide card's picture, twice a narrow one's. */
const WIDE_COLS = 128
/** Rows in a picture next to the charts, about as tall as them. */
const TALL_ROWS = 30

export async function BenefitCards() {
  const run = latestByTarget(await loadRuns(), "tsbs-iot").find(
    (r) => r.header.target === "aws-s3" && !r.header.variant,
  )
  const fast = speed(run)
  // Two rows of three: a wide card first in the top row, in the middle of the bottom one.
  const cards: Card[] = [
    {
      icon: Gauge,
      art: "fast",
      title: "Fast",
      body: fast.body,
      link: { label: "Benchmarks", href: "/benchmarks" },
      wide: true,
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
      art: "cheap",
      title: "Cheap",
      body: "You pay only for storage, reads, and writes. There’s no database server to keep running.",
      link: { label: "Cost", href: "/docs/storage#requests-and-cost" },
      figure: (
        <BarChart
          rows={keepingCost()}
          caption="Keeping the data a month, before reads and writes"
          legend={[
            { label: "Timelake on S3", color: "var(--chart-3)" },
            { label: "Tiger Cloud", color: "var(--muted-foreground)" },
          ]}
        />
      ),
    },
    {
      icon: Layers,
      art: "formats",
      title: "Open",
      body: "Tables are standard Iceberg and Parquet in your own bucket, so you’re not locked in: DuckDB and Spark read them too.",
      link: { label: "Querying", href: "/docs/querying" },
      rows: TALL_ROWS,
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
      wide: true,
    },
    {
      icon: Cloud,
      art: "stores",
      title: "Any object store",
      body: "Runs on AWS S3, Google Cloud Storage, Azure, R2, MinIO, or your local disk.",
      link: { label: "Storage", href: "/docs/storage" },
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
            className={cn("flex flex-col gap-2 rounded-lg border bg-card p-6", c.wide && "md:col-span-2")}
          >
            <h3 className="flex items-center gap-2.5 text-lg font-normal">
              <Icon className="size-4.5 text-muted-foreground" aria-hidden />
              {c.title}
            </h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{c.body}</p>
            {/* Pinned to the bottom, so pictures line up across a row. */}
            <div className="mt-auto pt-4">
              {c.figure ?? <UseCaseArt kind={c.art} cols={c.wide ? WIDE_COLS : undefined} rows={c.rows} />}
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
