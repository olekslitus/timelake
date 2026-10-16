import { ArrowRight } from "lucide-react"
import Link from "next/link"
import { Suspense } from "react"

import { BenchRanking } from "@/components/bench-ranking"
import { CodeBlock } from "@/components/code-block"
import { GithubIcon } from "@/components/github-icon"
import { StackDiagram } from "@/components/stack-diagram"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SYSTEMS, headline, loadRuns, rankings, type Versus } from "@/lib/benchmarks"
import { formatNumber, formatTime, timeUnit } from "@/lib/format"
import { REPO_URL } from "@/lib/site"

const BTN = "font-mono text-xs uppercase tracking-[0.06em]"

// The three promises, in this order everywhere (brand/README.md).
const PROMISES = [
  {
    title: "Fast every day",
    body: "Streaming small batches into an Iceberg table leaves thousands of small files, and queries stay slow until a compaction job runs. Timelake merges and sorts files as it writes them.",
  },
  {
    title: "Nothing to maintain",
    body: "Compaction, duplicate removal, retention and snapshot cleanup happen inside the writer. There are no Spark or Glue jobs to set up or pay for.",
  },
  {
    title: "Pay for storage, not a database",
    body: "There is no database server to run. You pay your cloud provider for storage and requests, and Timelake reads few files per query.",
  },
]

const HOW = [
  {
    title: "Files in your bucket",
    body: "Tables are Parquet files with Apache Iceberg metadata, in your own bucket on S3, R2, Google Cloud Storage or Azure, or on a local disk. DuckDB and Spark can read them directly.",
  },
  {
    title: "Sorted by series and time",
    body: "You tell Timelake which column holds the time and which columns identify a series. It sorts files by both and keeps the newest value of each series in a small index.",
  },
  {
    title: "Compacted as you write",
    body: "After each write, Timelake merges small files into larger ones and deletes old versions. Nothing else needs to run.",
  },
]

function SectionHead({ label, title, children }: { label: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex max-w-3xl flex-col gap-3">
      <div className="label-mono">{label}</div>
      <h2 className="text-3xl font-light tracking-tight text-balance">{title}</h2>
      {children ? <p className="text-muted-foreground">{children}</p> : null}
    </div>
  )
}

export default function Home() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-24 px-4 pt-10 pb-24 sm:pt-16">
      <section className="cells md:grid-cols-[1fr_1fr]">
        <div className="flex flex-col justify-center gap-6 p-7 sm:p-12">
          <div className="label-mono">Open source · Apache 2.0 · v0</div>
          <h1 className="text-4xl leading-[1.05] font-light tracking-tight text-balance sm:text-6xl">
            The open time&#8209;series lakehouse
          </h1>
          <p className="max-w-[46ch] text-lg text-muted-foreground">
            Timelake stores time series as Parquet files in your own S3 bucket. It sorts and compacts them as data
            arrives, so queries stay fast without a database server.
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
        <Suspense fallback={<div className="min-h-64" />}>
          <TopNumbers />
        </Suspense>
      </section>

      <section className="flex flex-col gap-6">
        <div className="label-mono">Why Timelake</div>
        <div className="cells md:grid-cols-3">
          {PROMISES.map((p) => (
            <div key={p.title} className="flex flex-col gap-3 p-6">
              <h3 className="text-xl font-normal">{p.title}</h3>
              <p className="text-sm text-muted-foreground">{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-6">
        <SectionHead label="How it works" title="Tables made of files in your bucket" />
        <StackDiagram />
        <div className="cells md:grid-cols-3">
          {HOW.map((h) => (
            <div key={h.title} className="flex flex-col gap-2 p-6">
              <h3 className="text-lg font-normal">{h.title}</h3>
              <p className="text-sm text-muted-foreground">{h.body}</p>
            </div>
          ))}
        </div>
        <nav className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <MoreLink href="/docs/how-it-works">How it works</MoreLink>
          <MoreLink href="/docs/architecture">Architecture</MoreLink>
        </nav>
      </section>

      <section className="flex flex-col gap-6">
        <SectionHead label="Quick start" title="Try it">
          Use a local folder, or an s3://, gs:// or az:// location.
        </SectionHead>
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

      <Suspense fallback={null}>
        <Benchmarks />
      </Suspense>
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

/** Timelake's time, and the others' range ("1.31–4.36 s"), in the same unit. */
const timed = (v: Versus): [string, string] => {
  const unit = timeUnit([v.timelake, ...v.others])
  const low = formatTime(v.others[0], unit).replace(/ m?s$/, "")
  return [formatTime(v.timelake, unit), `${low}–${formatTime(v.others[1], unit)}`]
}
const countRange = (v: Versus) => `${formatNumber(Math.round(v.others[0]))}–${formatNumber(Math.round(v.others[1]))}`
const seconds = (v: Versus): Versus => ({
  timelake: v.timelake / 1000,
  others: [v.others[0] / 1000, v.others[1] / 1000],
})

/** The hero's numbers: Timelake against the other lakes in the latest weekly run on S3, right after ingest. */
async function TopNumbers() {
  const h = headline(await loadRuns())
  if (!h) return null
  const { run } = h
  const others = Object.keys(run.header.readers)
    .filter((s) => s !== "timelake")
    .map((s) => SYSTEMS[s] ?? s)
  const [query, queryOthers] = timed(h.queries)
  const numbers: [string, string, string][] = [
    [query, "per query, right after streaming ingest", `Other lakes: ${queryOthers}`],
  ]
  if (h.requests) {
    numbers.push([
      formatNumber(Math.round(h.requests.timelake)),
      "S3 requests per query",
      `Other lakes: ${countRange(h.requests)}`,
    ])
  }
  if (h.commit) {
    const [commit, commitOthers] = timed(seconds(h.commit))
    numbers.push([commit, "per commit, compaction included", `Other lakes: ${commitOthers}`])
  }
  return (
    <div className="flex flex-col justify-center gap-6 p-7 sm:p-12">
      <dl className="flex flex-col gap-5">
        {numbers.map(([value, what, context]) => (
          <div key={what} className="flex flex-col gap-0.5">
            <dt className="font-mono text-3xl text-primary tabular-nums">{value}</dt>
            <dd className="text-sm">{what}</dd>
            <dd className="font-mono text-xs text-muted-foreground">{context}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">
        TSBS IoT streamed into AWS S3 in five-minute batches, weekly run of {run.header.started.slice(0, 10)}. Other
        lakes: {others.join(", ")}, each with its fastest reader.{" "}
        <Link
          href="/benchmarks/tsbs-iot"
          className="underline decoration-primary underline-offset-4 hover:text-foreground"
        >
          Results and method
        </Link>
      </p>
    </div>
  )
}

async function Benchmarks() {
  const h = headline(await loadRuns())
  if (!h) return null
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <SectionHead label="Benchmarks" title="TSBS IoT on AWS S3">
          From the latest weekly run. Timelake is in blue.
        </SectionHead>
        <Button variant="outline" className={BTN} nativeButton={false} render={<Link href="/benchmarks" />}>
          All benchmarks <ArrowRight />
        </Button>
      </div>
      <div className="grid gap-x-10 gap-y-6 lg:grid-cols-2">
        {rankings(h.run).map((r) => (
          <BenchRanking key={r.title} ranking={r} />
        ))}
      </div>
    </section>
  )
}
