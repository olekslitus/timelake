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

const HERO_CODE = `import timelake

lake = timelake.Lake("s3://my-bucket/lake")
t = lake.create_table("plant.readings", schema,
        time_column="time", series_key=["tag"])
t.append(batch)   # every few seconds or minutes

lake.sql("""SELECT tag, avg(value)
            FROM plant.readings
            WHERE time > now() - INTERVAL '1 hour'
            GROUP BY tag""")`

// The three promises, in this order everywhere (brand/README.md).
const PROMISES = [
  {
    title: "Fast every day",
    body: "Data streamed into a lake in small batches usually leaves thousands of small files until a compaction job runs. Timelake keeps files few and sorted as it writes, so queries are fast from the first minute.",
  },
  {
    title: "Nothing to maintain",
    body: "Small files, duplicates, retention and old versions are handled inside the writer. No Spark or Glue jobs to set up, size and pay for.",
  },
  {
    title: "Pay for storage, not a database",
    body: "No server running all month. The bill is bytes and requests on object storage, and Timelake keeps the requests low.",
  },
]

const HOW = [
  {
    title: "Files in your bucket",
    body: "Parquet files and Apache Iceberg metadata, in your own bucket on S3, R2, Google Cloud, Azure or a disk. DuckDB, Spark and others read them too.",
  },
  {
    title: "Built for time series",
    body: "You name the time column and what identifies a series. Files are sorted by both, and the newest value of every series is kept in a small index.",
  },
  {
    title: "Tidied as you write",
    body: "Each write merges small files and drops old versions, so tables stay fast without anything else running.",
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
            Keep time series in your own bucket. Query them fast, run no database, and schedule no maintenance.
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
        <div className="flex min-w-0 flex-col justify-center p-5 sm:p-8">
          <CodeBlock title="python">{HERO_CODE}</CodeBlock>
        </div>
      </section>

      <section className="flex flex-col gap-6">
        <SectionHead label="What you get" title="Fast queries without a database or maintenance jobs" />
        <Suspense fallback={<Promises />}>
          <MeasuredPromises />
        </Suspense>
      </section>

      <section className="flex flex-col gap-6">
        <SectionHead label="How it works" title="A table format that knows it holds time series" />
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
        <SectionHead label="Quick start" title="Point it at a bucket">
          A local directory or an s3://, gs:// or az:// location.
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

/** The promises, each with its number from the latest weekly run when there is one. */
function Promises({ proof }: { proof?: ([string, string] | null)[] }) {
  return (
    <div className="cells md:grid-cols-3">
      {PROMISES.map((p, i) => {
        const shown = proof?.[i]
        return (
          <div key={p.title} className="flex flex-col gap-3 p-6">
            <h3 className="text-xl font-normal">{p.title}</h3>
            <p className="text-sm text-muted-foreground">{p.body}</p>
            {shown && (
              <div className="mt-auto flex flex-col gap-0.5 border-t border-dashed pt-3 font-mono text-[13px] leading-snug">
                <span>{shown[0]}</span>
                <span className="text-muted-foreground">{shown[1]}</span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Timelake's time against the others' range, all in one unit. */
const times = (v: Versus) => {
  const unit = timeUnit([v.timelake, ...v.others])
  const low = formatTime(v.others[0], unit).replace(/ m?s$/, "")
  return `${formatTime(v.timelake, unit)} vs ${low}–${formatTime(v.others[1], unit)}`
}
const seconds = (v: Versus): Versus => ({
  timelake: v.timelake / 1000,
  others: [v.others[0] / 1000, v.others[1] / 1000],
})
const counts = (v: Versus) =>
  `${formatNumber(Math.round(v.timelake))} vs ${formatNumber(Math.round(v.others[0]))}–${formatNumber(Math.round(v.others[1]))}`

async function MeasuredPromises() {
  const h = headline(await loadRuns())
  if (!h) return <Promises />
  const { run } = h
  const others = Object.keys(run.header.readers)
    .filter((s) => s !== "timelake")
    .map((s) => SYSTEMS[s] ?? s)
  const commits = run.phases.find((p) => p.kind === "ingest" && p.system === "timelake")?.commits
  const proof: ([string, string] | null)[] = [
    [times(h.queries), "per query on S3 right after streaming ingest, against other lakes"],
    h.commit
      ? [
          `${times(seconds(h.commit))} per commit`,
          `${commits ? formatNumber(commits) : "every"} commits, no maintenance jobs`,
        ]
      : null,
    h.requests ? [`${counts(h.requests)} S3 requests`, "per query right after ingest; requests are billed"] : null,
  ]
  return (
    <>
      <Promises proof={proof} />
      <p className="max-w-3xl text-xs text-muted-foreground">
        TSBS IoT streamed into AWS S3 in five-minute batches, from the weekly run of {run.header.started.slice(0, 10)}{" "}
        on {run.header.machine} in the same region. Compared with {others.join(", ")}, each with its fastest reader.{" "}
        <Link
          href="/benchmarks/tsbs-iot"
          className="underline decoration-primary underline-offset-4 hover:text-foreground"
        >
          Results and method
        </Link>
      </p>
    </>
  )
}

async function Benchmarks() {
  const h = headline(await loadRuns())
  if (!h) return null
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <SectionHead label="Benchmarks" title="Measured every week">
          TSBS IoT on AWS S3, from the latest weekly run. Timelake in blue.
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
