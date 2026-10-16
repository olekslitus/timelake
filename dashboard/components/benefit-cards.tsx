import { Activity, ArrowRight, Cloud, Gauge, Layers, Scale, ServerOff, type LucideIcon } from "lucide-react"
import Link from "next/link"

import { latestByTarget, loadRuns, rankings } from "@/lib/benchmarks"
import { REPO_URL } from "@/lib/site"
import { cn } from "@/lib/utils"

/** Writers and readers in your processes, files in your bucket, nothing in between. */
const PROCESSES = (
  <>
    {"python ─┐\ncli    ─┤   ┌──────────────┐\ncron   ─┼──▶│ "}
    <span className="hi">s3://bucket/</span>
    {" │\nlambda ─┘   │   metadata/  │\n            │   data/      │\n            └──────────────┘"}
  </>
)

/** The same files, written by Timelake and read by other tools. */
const FORMATS = (
  <>
    {"cli    ─┐           ┌─ duckdb\npython ─┼─ "}
    <span className="hi">iceberg</span>
    {" ─┼─ spark\nrust   ─┘  "}
    <span className="hi">parquet</span>
    {"  └─ pyiceberg"}
  </>
)

type Card = {
  icon: LucideIcon
  title: string
  body: string
  link: { label: string; href: string }
  wide?: boolean
  art?: React.ReactNode
}

/** Timelake's query times in the newest weekly S3 run, against the other systems in it. */
async function speed(): Promise<string> {
  const run = latestByTarget(await loadRuns(), "tsbs-iot").find(
    (r) => r.header.target === "aws-s3" && !r.header.variant,
  )
  const ranked = run ? rankings(run) : []
  const rows = (prefix: string) => ranked.find((r) => r.title.startsWith(prefix))?.rows ?? []
  const maintained = rows("Queries, after").find((r) => r.timelake)
  const ingested = rows("Queries, right")
  const own = ingested.find((r) => r.timelake)
  const others = ingested.filter((r) => r.system !== "timelake").map((r) => r.value)
  if (!maintained || !own || others.length === 0) return "Measured every week against other lakes on S3."
  const x = (v: number) => Math.round(v / own.value)
  const range = `${x(Math.min(...others))}⁠–⁠${x(Math.max(...others))}×`
  return `Queries on S3 return in ${Math.round(maintained.value * 1000)} ms, and are ${range} faster than other lakes on fresh data.`
}

export async function BenefitCards() {
  // Two rows of three: a wide card first in the top row, in the middle of the bottom one.
  const cards: Card[] = [
    {
      icon: ServerOff,
      title: "Serverless",
      body: "No database or maintenance jobs to run. When nothing is querying, you pay only for the files in your bucket.",
      link: { label: "How it works", href: "/docs/how-it-works" },
      wide: true,
      art: PROCESSES,
    },
    {
      icon: Activity,
      title: "Time-series analytics",
      body: "Data is laid out by time and series, so queries read only what they need.",
      link: { label: "Performance", href: "/docs/performance" },
    },
    {
      icon: Gauge,
      title: "Fast",
      body: await speed(),
      link: { label: "Benchmarks", href: "/benchmarks" },
    },
    {
      icon: Cloud,
      title: "Any object store",
      body: "Runs on AWS S3, Google Cloud Storage, Azure, R2, MinIO or your local disk.",
      link: { label: "Storage", href: "/docs/storage" },
    },
    {
      icon: Layers,
      title: "Open formats",
      body: "Your tables are standard Iceberg and Parquet, so DuckDB and Spark can query them too.",
      link: { label: "Querying", href: "/docs/querying" },
      wide: true,
      art: FORMATS,
    },
    {
      icon: Scale,
      title: "Open source",
      body: "Apache 2.0 licensed, and built on Apache Arrow and DataFusion.",
      link: { label: "GitHub", href: REPO_URL },
    },
  ]
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {cards.map((c) => {
        const Icon = c.icon
        return (
          <div
            key={c.title}
            className={cn(
              "relative flex flex-col gap-2 overflow-hidden rounded-lg border bg-card p-6",
              c.wide && "md:col-span-2",
            )}
          >
            <h3 className="flex items-center gap-2.5 text-lg font-normal">
              <Icon className="size-4.5 text-muted-foreground" aria-hidden />
              {c.title}
            </h3>
            <p className={cn("text-sm leading-relaxed text-muted-foreground", c.art && "xl:max-w-[50%]")}>{c.body}</p>
            <Link
              href={c.link.href}
              {...(c.link.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
              className="mt-auto flex w-fit items-center gap-1.5 pt-2 text-sm hover:underline"
            >
              {c.link.label} <ArrowRight className="size-3.5" />
            </Link>
            {c.art ? (
              <pre
                aria-hidden
                className="ascii pointer-events-none absolute top-1/2 right-8 hidden -translate-y-1/2 text-[12px] leading-[1.3] xl:block"
              >
                {c.art}
              </pre>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
