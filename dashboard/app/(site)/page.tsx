import { ArrowRight } from "lucide-react"
import Link from "next/link"
import { Suspense } from "react"

import { BenchRanking } from "@/components/bench-ranking"
import { WORDMARK } from "@/components/brand/mark-geometry"
import { TimelakeMark } from "@/components/brand/timelake-mark"
import { CodeBlock } from "@/components/code-block"
import { GithubIcon } from "@/components/github-icon"
import { StackDiagram } from "@/components/stack-diagram"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SYSTEMS, latestByTarget, loadRuns, rankings } from "@/lib/benchmarks"
import { REPO_URL } from "@/lib/site"

const BTN = "font-mono text-xs uppercase tracking-[0.06em]"

/** The dim /\/\ field behind the hero lockup: larger than any viewport, centred on the lockup and clipped by its block. */
const FIELD = Array.from({ length: 40 }, (_, r) => (r % 2 ? "\\/" : "/\\").repeat(120)).join("\n")

const PARTS = [
  {
    title: "Writing",
    body: "An append writes Arrow data as Parquet files, partitioned by time (hour, day or month) and sorted by series and time. Each commit is a new metadata file written with a conditional put, so concurrent writers can't overwrite each other and no catalog server is needed.",
  },
  {
    title: "Maintenance",
    body: "After an append, the writer merges small files of similar size within a partition and expires old snapshots. A full pass rewrites each partition into one sorted file and removes duplicate rows. Retention drops whole partitions.",
  },
  {
    title: "Reading",
    body: "SQL runs in DataFusion, embedded in the CLI and the Python and Rust libraries. Queries skip files and row groups by time and series, and latest-value queries read a small index updated on every append. A TypeScript client reads the same files in the browser, and DuckDB, Spark and other Iceberg readers can read them too.",
  },
]

const USE_CASES = [
  {
    title: "Industrial sensor data",
    body: "Plants with thousands of tags sampled every second to every minute, from gateways that sometimes go offline and send their backlog later. Our industrial IoT benchmark models this; its first results are being collected.",
  },
  {
    title: "Vehicle and device fleets",
    body: "Location and diagnostics from thousands of devices every few seconds. Measured weekly with TSBS IoT.",
  },
  {
    title: "Server metrics",
    body: "CPU and system metrics from thousands of hosts. Measured weekly with TSBS DevOps.",
  },
  {
    title: "Data read by several tools",
    body: "Tables that DuckDB, Spark, notebooks and browser dashboards read directly from the bucket, without exporting copies.",
  },
]

/** The main limitations of v0 (docs/limitations). */
const LIMITATIONS = [
  "No row-level deletes: retention drops whole partitions only.",
  "The schema is fixed when a table is created.",
  "Rows sent twice stay visible until compaction removes them.",
  "Data becomes visible when its append commits; there is no buffer for sub-second freshness.",
  "Tables are found by path; engines that only speak the Iceberg REST catalog protocol can't attach yet.",
  "Google Cloud Storage, Azure Blob Storage and R2 use the same code as S3 but haven't been tested yet.",
]

/** Mark + "timelake" in the middle of its cell, on a card-coloured rectangle that masks the field. */
function HeroLockup() {
  // The mark's height, from the container's width; the rest follows the brand proportions (brand/marks.mjs).
  const m = "17cqw"
  const of = (k: number) => `calc(${m} * ${k})`
  return (
    <div
      role="img"
      aria-label="Timelake"
      className="relative flex items-center bg-card"
      style={{ gap: of(WORDMARK.gapOfMark), padding: `${of(0.1)} ${of(0.16)}` }}
    >
      <TimelakeMark
        className="shrink-0"
        style={{ width: m, height: m, transform: `translateY(${of(WORDMARK.markDropOfMark)})` }}
      />
      <span
        className="font-sans leading-none"
        style={{
          fontSize: of(WORDMARK.sizeOfMark),
          fontWeight: WORDMARK.weight,
          letterSpacing: `${WORDMARK.letterSpacingEm}em`,
        }}
      >
        {WORDMARK.text}
      </span>
    </div>
  )
}

function SectionHead({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="flex max-w-3xl flex-col gap-3">
      <h2 className="label-mono">{label}</h2>
      {children ? <p className="text-muted-foreground">{children}</p> : null}
    </div>
  )
}

function MoreLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="flex w-fit items-center gap-1 text-sm hover:underline">
      {children} <ArrowRight className="size-3.5" />
    </Link>
  )
}

export default function Home() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-24 px-4 pt-10 pb-24 sm:pt-16">
      <section className="cells md:grid-cols-2">
        <div className="@container relative grid place-items-center overflow-hidden px-4 py-[10%]">
          <pre
            aria-hidden
            className="ascii absolute inset-0 grid place-content-center overflow-hidden text-xs leading-normal"
          >
            {FIELD}
          </pre>
          <HeroLockup />
        </div>
        <div className="flex flex-col justify-center gap-6 p-7 sm:p-10">
          <h1 className="text-4xl leading-[1.05] font-light tracking-tight text-balance sm:text-5xl">
            The open time&#8209;series lakehouse
          </h1>
          <div className="label-mono">Open source · Apache 2.0 · v0</div>
          <p className="text-muted-foreground">
            Timelake writes time series to your own S3 bucket or local disk as Apache Iceberg tables, keeps them
            compacted and within retention, and queries them with SQL from the command line, Python, Rust or the
            browser. It runs inside your own processes, with no database server and no maintenance jobs to schedule.
          </p>
          <div className="flex flex-wrap gap-2.5">
            <Button size="lg" className={BTN} nativeButton={false} render={<Link href="/docs/quick-start" />}>
              Quick start <ArrowRight />
            </Button>
            <Button
              size="lg"
              variant="outline"
              className={BTN}
              nativeButton={false}
              render={<a href={REPO_URL} target="_blank" rel="noreferrer" />}
            >
              <GithubIcon /> GitHub
            </Button>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-6">
        <SectionHead label="How it works">
          Timelake is a library, not a server. Writers, maintenance and readers run in your own processes; everything
          they share is in the bucket.
        </SectionHead>
        <StackDiagram />
        <div className="cells md:grid-cols-3">
          {PARTS.map((p) => (
            <div key={p.title} className="flex flex-col gap-2 p-6">
              <h3 className="text-lg font-normal">{p.title}</h3>
              <p className="text-sm text-muted-foreground">{p.body}</p>
            </div>
          ))}
        </div>
        <nav className="flex flex-wrap gap-x-5 gap-y-1">
          <MoreLink href="/docs/how-it-works">How it works</MoreLink>
          <MoreLink href="/docs/architecture">Architecture</MoreLink>
        </nav>
      </section>

      <section className="flex flex-col gap-6">
        <SectionHead label="Use cases" />
        <div className="cells sm:grid-cols-2">
          {USE_CASES.map((u) => (
            <div key={u.title} className="flex flex-col gap-2 p-6">
              <h3 className="text-lg font-normal">{u.title}</h3>
              <p className="text-sm text-muted-foreground">{u.body}</p>
            </div>
          ))}
        </div>
      </section>

      <Suspense fallback={null}>
        <Measurements />
      </Suspense>

      <section className="flex flex-col gap-6">
        <SectionHead label="Limitations">Timelake is at v0. What it doesn&apos;t do yet:</SectionHead>
        <ul className="flex max-w-3xl list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
          {LIMITATIONS.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <nav className="flex flex-wrap gap-x-5 gap-y-1">
          <MoreLink href="/docs/limitations">All limitations</MoreLink>
          <MoreLink href="/roadmap">Roadmap</MoreLink>
        </nav>
      </section>

      <section className="flex flex-col gap-6">
        <SectionHead label="Quick start">Use a local folder, or an s3://, gs:// or az:// location.</SectionHead>
        <Tabs defaultValue="cli">
          <TabsList>
            <TabsTrigger value="cli">CLI</TabsTrigger>
            <TabsTrigger value="python">Python</TabsTrigger>
            <TabsTrigger value="duckdb">DuckDB</TabsTrigger>
          </TabsList>
          <TabsContent value="cli" className="pt-2">
            <CodeBlock title="shell">{`export TIMELAKE_WAREHOUSE=s3://my-bucket/lake

# Create a time-series table from a file's schema and load it
timelake import iot.readings readings.parquet --time-column time --series-key device_id

timelake sql "SELECT device_id, time_bucket(INTERVAL '1 hour', time) AS h, avg(temp)
              FROM iot.readings WHERE time > now() - INTERVAL '1 day' GROUP BY 1, 2"
timelake latest iot.readings     # newest row per device, from the index`}</CodeBlock>
          </TabsContent>
          <TabsContent value="python" className="pt-2">
            <CodeBlock title="python">{`import timelake

lake = timelake.Lake("s3://my-bucket/lake")
t = lake.create_table("iot.readings", batch.schema,
                      time_column="time", series_key=["device_id"], retention="365d")
t.append(batch)                                   # pyarrow, polars, any Arrow stream

lake.sql("SELECT * FROM iot.readings WHERE device_id = 'pump-7' ORDER BY time DESC LIMIT 1")
lake.latest("iot.readings")                       # pyarrow.Table, one row per device`}</CodeBlock>
          </TabsContent>
          <TabsContent value="duckdb" className="pt-2">
            <CodeBlock title="duckdb">{`INSTALL iceberg; LOAD iceberg;
-- no catalog and no Timelake needed
SELECT device_id, max(time) FROM iceberg_scan('s3://my-bucket/lake/iot/readings') GROUP BY 1;`}</CodeBlock>
          </TabsContent>
        </Tabs>
        <MoreLink href="/docs/quick-start">Quick start</MoreLink>
      </section>
    </div>
  )
}

/** The latest weekly run of TSBS IoT on S3: what was measured, and the results. */
async function Measurements() {
  const run = latestByTarget(await loadRuns(), "tsbs-iot").find(
    (r) => r.header.target === "aws-s3" && !r.header.variant,
  )
  if (!run) return null
  const systems = Object.keys(run.header.readers).map((s) => SYSTEMS[s] ?? s)
  return (
    <section className="flex flex-col gap-6">
      <SectionHead label="Measurements">
        Every Monday, timebench, our benchmark tool, streams the same data into {systems.join(", ")} on one AWS instance
        in us-east-2 and times every query from a fresh process. Below: TSBS IoT on S3, run of{" "}
        {run.header.started.slice(0, 10)}. It uses TSBS&apos;s data and queries with our own method, so the numbers
        don&apos;t compare with published TSBS results. Lower is better; Timelake is in blue.
      </SectionHead>
      <div className="grid gap-x-10 gap-y-6 lg:grid-cols-2">
        {rankings(run).map((r) => (
          <BenchRanking key={r.title} ranking={r} />
        ))}
      </div>
      <nav className="flex flex-wrap gap-x-5 gap-y-1">
        <MoreLink href="/benchmarks">All benchmarks</MoreLink>
        <MoreLink href="/benchmarks/timebench">How we measure</MoreLink>
      </nav>
    </section>
  )
}
