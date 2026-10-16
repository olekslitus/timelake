import { Activity, ArrowRight, Code, Layers, RefreshCw, Scale, ServerOff, type LucideIcon } from "lucide-react"
import Link from "next/link"

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
    {"cli    ─┐           ┌─ timelake\npython ─┼─ "}
    <span className="hi">iceberg</span>
    {" ─┼─ duckdb\nrust   ─┘  "}
    <span className="hi">parquet</span>
    {"  └─ browser"}
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

// Two rows of three: a wide card first in the top row, in the middle of the bottom one.
const CARDS: Card[] = [
  {
    icon: ServerOff,
    title: "Serverless",
    body: "No database, catalog service or Spark jobs. Your data is files in your own bucket.",
    link: { label: "How it works", href: "/docs/how-it-works" },
    wide: true,
    art: PROCESSES,
  },
  {
    icon: Activity,
    title: "Built for time series",
    body: "Partitioned by time, sorted by series, with an index of latest values.",
    link: { label: "Performance", href: "/docs/performance" },
  },
  {
    icon: RefreshCw,
    title: "Maintains itself",
    body: "Compaction, deduplication and retention run inside the writer.",
    link: { label: "Architecture", href: "/docs/architecture" },
  },
  {
    icon: Code,
    title: "Your languages",
    body: "CLI, Python and Rust, and TypeScript in the browser.",
    link: { label: "Quick start", href: "/docs/quick-start" },
  },
  {
    icon: Layers,
    title: "Open formats",
    body: "Iceberg tables of Parquet files. DuckDB reads them without Timelake.",
    link: { label: "Storage", href: "/docs/storage" },
    wide: true,
    art: FORMATS,
  },
  {
    icon: Scale,
    title: "Free and open source",
    body: "Apache 2.0, built on Apache Arrow and DataFusion.",
    link: { label: "GitHub", href: REPO_URL },
  },
]

export function BenefitCards() {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {CARDS.map((c) => {
        const Icon = c.icon
        const external = c.link.href.startsWith("http")
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
              {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
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
