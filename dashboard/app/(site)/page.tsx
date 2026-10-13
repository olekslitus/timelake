import Link from "next/link"
import { ArrowRight, Boxes, Database, FileStack, GitCommitHorizontal, Layers, Rows3, ScanSearch, Timer, Wrench } from "lucide-react"

import { TimelakeMark } from "@/components/brand/timelake-mark"
import { CodeBlock } from "@/components/code-block"
import { GithubIcon } from "@/components/github-icon"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { WhereItRuns } from "@/components/where-it-runs"
import { REPO_URL } from "@/lib/site"

// The three promises, in this order everywhere (brand/README.md). Numbers are from bench/results/V0.md.
const PROMISES = [
  {
    title: "Fast every day",
    body: "Dashboards, trends and “what is the value now” read only the files and row groups they need. The latest value of every series comes from an index, not a scan.",
    proof: [
      ["12 requests vs 1,733", "for the latest position of every truck"],
      ["3.7–16× faster", "TSBS IoT queries right after streaming ingest"],
    ],
    art: (
      <>
        {"+ + + + + + + + + + + + + +\n+ + [ ] [ ] [ ] [ ] [ ] + +\n+ + [ ] [ ] "}
        <span className="hi">[#]</span>
        {" [ ] [ ] + +\n+ + [ ] [ ] "}
        <span className="hi">[#]</span>
        {" [ ] [ ] + +\n+ + [ ] [ ] [ ] [ ] [ ] + +\n+ + + + + + + + + + + + + +\n"}
        <span className="mu">{"  query reads 2 of 25 files"}</span>
      </>
    ),
  },
  {
    title: "Nothing to maintain",
    body: "Compaction, deduplication, retention and snapshot cleanup run inside the writer. No Spark or Glue jobs to schedule, size, monitor or pay for.",
    proof: [
      ["1,728 commits, 0 jobs", "six days of five-minute batches, nothing scheduled"],
      ["434 s vs 817–1,607 s", "to stream them to S3, compaction included"],
    ],
    art: (
      <>
        <span className="fg">{"[][][][][][][][][][][][][]"}</span>
        {"\n \\/  \\/  \\/  \\/  \\/  \\/\n"}
        <span className="fg">{"[==][==][==][==][==][==]"}</span>
        {"\n   \\___\\___|___/___/\n"}
        <span className="hi">{"[======================]"}</span>
        {"\n"}
        <span className="mu">{"  merged while you write"}</span>
      </>
    ),
  },
  {
    title: "Pay for storage, not a database",
    body: "No instance running all month. The bill is object-storage bytes and requests, and Timelake keeps both low: compact sorted files and few requests per query.",
    proof: [
      ["228 MB vs 262–449 MB", "for the same data (Iceberg, Lance)"],
      ["$ per month per workload", "measured next, in the IIoT benchmark"],
    ],
    art: (
      <>
        <span className="fg">STORAGE </span>
        {"  GB-month x $0.023\n"}
        <span className="fg">GET     </span>
        {"  per 1k   x $0.0004\n"}
        <span className="fg">PUT     </span>
        {"  per 1k   x $0.005\n"}
        <span className="fg">SERVERS </span>
        {"  ............ "}
        <span className="hi">$0</span>
        {"\n"}
        <span className="fg">JOBS    </span>
        {"  ............ "}
        <span className="hi">$0</span>
        {"\n"}
        <span className="mu">{"  S3 standard, us-east-1"}</span>
      </>
    ),
  },
]

const SUPPORT = [
  { title: "Open format", body: "Parquet files and open table metadata. DuckDB, Spark and PyIceberg read them today." },
  { title: "Any object store", body: "S3, R2, GCS, Azure, MinIO or a disk, and read-only from any HTTPS host. Tested so far on local disk and RustFS." },
  { title: "Apache 2.0", body: "The engine, the CLI and the clients. No closed core." },
]

const PROBLEMS = [
  {
    icon: FileStack,
    title: "Frequent appends make small files",
    body: "Streaming 5-minute batches into an Iceberg table (the S3 Tables + Firehose pattern) leaves one file and one manifest per commit: 864 of each per table after three days in our test. Readers fetch all of them.",
  },
  {
    icon: Wrench,
    title: "Maintenance is a separate system",
    body: "Compaction, re-sorting, retention and snapshot expiry run as Glue or Spark jobs that someone schedules, sizes, pays for and debugs. Until they run, queries pay for the raw layout.",
  },
  {
    icon: Timer,
    title: "Generic engines don't know it's time series",
    body: "“Latest value per device” scans the whole table. A query for one device in the last hour still opens files for every device, because nothing sorted or indexed the data by series.",
  },
]

const HOW = [
  {
    icon: GitCommitHorizontal,
    title: "A catalog that is just files",
    body: "Each commit writes vN.metadata.json with put-if-absent (S3 If-None-Match and equivalents). Exactly one concurrent writer wins; the others rebase and retry.",
  },
  {
    icon: Rows3,
    title: "A time-series contract",
    body: "Declare a time column and a series key, like a TimescaleDB hypertable. Tables are partitioned by hour, day or month, and every file is sorted by (series key, time).",
  },
  {
    icon: Layers,
    title: "Maintenance inside the writer",
    body: "After an append, size-tiered compaction merges similar-sized small files and old snapshots expire in batches. timelake maintain rewrites each partition into one sorted, deduplicated file.",
  },
  {
    icon: Database,
    title: "A last-value index",
    body: "Every append updates a small Parquet file with the newest row per series, referenced from the snapshot. “Latest per device” becomes one small read.",
  },
  {
    icon: ScanSearch,
    title: "A reader that knows the layout",
    body: "A DataFusion table provider prunes files on column bounds, rewrites latest-row queries to the index, loads a query's tables concurrently and reads each Parquet footer once.",
  },
  {
    icon: Boxes,
    title: "Stored as Apache Iceberg + Parquet",
    body: "Today tables are Iceberg v2 with Parquet data files in the Hadoop-catalog layout, so DuckDB's iceberg_scan reads them without Timelake installed.",
  },
]

const HIGHLIGHTS = [
  { value: "3.7–16×", label: "faster TSBS IoT queries on S3 right after streaming ingest", detail: "0.28 s vs 1.05–4.50 s, first run" },
  { value: "1.2–1.5×", label: "faster after every system's own compaction", detail: "0.29 s vs 0.36–0.42 s, first run" },
  { value: "12 vs 1,733", label: "requests for the latest position of every truck", detail: "Timelake vs naive Iceberg (Lance: 3,614)" },
  { value: "434 s", label: "to stream 1,728 commits to S3, compaction included", detail: "Lance 817 s, PyIceberg 1,607 s" },
]

const BTN = "font-mono text-xs uppercase tracking-[0.06em]"

// Dim ASCII field behind the hero mark.
const FIELD = Array.from({ length: 22 }, (_, r) => (r % 2 ? "\\/" : "/\\").repeat(30)).join("\n")

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
      {/* Hero */}
      <section className="cells md:grid-cols-[1.35fr_1fr]">
        <div className="flex flex-col justify-center gap-6 p-7 sm:p-12">
          <div className="label-mono">Open source · Apache 2.0 · v0</div>
          <h1 className="text-4xl leading-[1.05] font-light tracking-tight text-balance sm:text-6xl">
            The open time&#8209;series lakehouse
          </h1>
          <p className="max-w-[46ch] text-lg text-muted-foreground">
            Keep time series in your own bucket on S3, R2, GCS, Azure or a disk. Query them fast, run no database, and
            schedule no maintenance.
          </p>
          <div className="flex flex-wrap gap-2.5">
            <Button size="lg" className={BTN} render={<Link href="/docs/quick-start" />}>
              Quick start <ArrowRight />
            </Button>
            <Button size="lg" variant="outline" className={BTN} render={<Link href="/benchmarks" />}>
              Benchmarks
            </Button>
            <Button size="lg" variant="outline" className={BTN} render={<Link href="/explore" />}>
              Explorer
            </Button>
            <Button size="lg" variant="ghost" className={BTN} render={<a href={REPO_URL} target="_blank" rel="noreferrer" />}>
              <GithubIcon /> GitHub
            </Button>
          </div>
        </div>
        <div className="relative grid min-h-64 place-items-center overflow-hidden p-8">
          <pre aria-hidden className="ascii absolute inset-0 overflow-hidden p-3 text-xs leading-normal">
            {FIELD}
          </pre>
          <div className="relative aspect-square w-[min(220px,60%)] rounded-full bg-card p-4">
            <TimelakeMark className="size-full" />
          </div>
        </div>
      </section>

      {/* Promises */}
      <section className="flex flex-col gap-6">
        <SectionHead label="What you get" title="Speed you feel every day, no maintenance work, a smaller bill" />
        <div className="cells md:grid-cols-3">
          {PROMISES.map((p) => (
            <div key={p.title} className="flex flex-col gap-4 p-6">
              <pre aria-hidden className="ascii min-h-[170px]">
                {p.art}
              </pre>
              <h3 className="text-xl font-normal">{p.title}</h3>
              <p className="text-sm text-muted-foreground">{p.body}</p>
              <div className="mt-auto flex flex-col gap-1 border-t border-dashed pt-3 font-mono text-[13px] leading-snug">
                {p.proof.map(([v, d]) => (
                  <span key={v}>
                    {v} <span className="text-muted-foreground">{d}</span>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="cells md:grid-cols-3">
          {SUPPORT.map((s) => (
            <div key={s.title} className="flex flex-col gap-1 p-5">
              <span className="text-base">{s.title}</span>
              <span className="text-sm text-muted-foreground">{s.body}</span>
            </div>
          ))}
        </div>
        <p className="max-w-3xl text-xs text-muted-foreground">
          Measured on TSBS IoT data streamed as 1,728 five-minute batches. &ldquo;S3&rdquo; is RustFS on one laptop behind a
          proxy that adds 20 ms per request, not AWS; real-S3 runs and the IIoT benchmark are next.{" "}
          <Link href="/benchmarks" className="underline decoration-primary underline-offset-4 hover:text-foreground">
            All results
          </Link>
        </p>
      </section>

      {/* Why */}
      <section className="flex flex-col gap-6">
        <SectionHead label="Why" title="Time series on a lake today means small files and extra jobs">
          Teams put telemetry in S3 Tables or self-managed Iceberg because it is cheap, durable and readable by every engine.
          Then they write custom jobs to make it fast.
        </SectionHead>
        <div className="cells md:grid-cols-3">
          {PROBLEMS.map((p) => (
            <div key={p.title} className="flex flex-col gap-3 p-6">
              <p.icon className="size-5 text-muted-foreground" aria-hidden />
              <h3 className="text-lg font-normal">{p.title}</h3>
              <p className="text-sm text-muted-foreground">{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Where it runs */}
      <section className="flex flex-col gap-6">
        <SectionHead label="Architecture" title="Where every part of Timelake runs">
          Four places code can run, one bucket underneath, and exactly what crosses the wire. Writers, maintenance and readers
          are stateless: everything durable is in object storage.
        </SectionHead>
        <WhereItRuns />
      </section>

      {/* How */}
      <section className="flex flex-col gap-6">
        <SectionHead label="How it works" title="A table format that knows it holds time series" />
        <div className="cells sm:grid-cols-2 lg:grid-cols-3">
          {HOW.map((h) => (
            <div key={h.title} className="flex flex-col gap-3 p-6">
              <h.icon className="size-5 text-primary" aria-hidden />
              <h3 className="text-base font-normal">{h.title}</h3>
              <p className="text-sm text-muted-foreground">{h.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Quick start */}
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
timelake latest iot.readings     # newest row per device, from the index
timelake maintain                # compact, retention, expire (also runs inline)`}</CodeBlock>
          </TabsContent>
          <TabsContent value="python" className="pt-2">
            <CodeBlock title="python">{`import timelake

lake = timelake.Lake("s3://my-bucket/lake")
t = lake.create_table("iot.readings", batch.schema,
                      time_column="time", series_key=["device_id"], retention="365d")
t.append(batch)                                   # pyarrow, polars, any Arrow stream
t.append(batch, batch_id="shard-7-seq-1234")      # idempotent retries

lake.sql("SELECT * FROM iot.readings WHERE device_id = 'pump-7' ORDER BY time DESC LIMIT 1")
lake.latest("iot.readings")                       # pyarrow.Table, one row per device`}</CodeBlock>
          </TabsContent>
          <TabsContent value="duckdb" className="pt-2">
            <CodeBlock title="duckdb">{`INSTALL iceberg; LOAD iceberg;
-- reads metadata/version-hint.text, no catalog or Timelake needed
SELECT device_id, max(time) FROM iceberg_scan('s3://my-bucket/lake/iot/readings') GROUP BY 1;`}</CodeBlock>
          </TabsContent>
        </Tabs>
      </section>

      {/* Benchmarks */}
      <section className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <SectionHead label="Benchmarks" title="v0 against naive Iceberg and Lance">
            TSBS IoT data (23.3M rows) streamed as 1,728 five-minute micro-batches into Timelake, Lance and naive Iceberg
            (PyIceberg appends, the S3 Tables write pattern), then queried with the 12 TSBS IoT queries.
          </SectionHead>
          <Button variant="outline" className={BTN} render={<Link href="/benchmarks" />}>
            All results <ArrowRight />
          </Button>
        </div>
        <div className="cells sm:grid-cols-2 lg:grid-cols-4">
          {HIGHLIGHTS.map((h) => (
            <div key={h.label} className="flex flex-col gap-2 p-5">
              <span className="font-mono text-2xl tabular-nums text-primary">{h.value}</span>
              <span className="text-sm">{h.label}</span>
              <span className="mt-auto font-mono text-xs text-muted-foreground">{h.detail}</span>
            </div>
          ))}
        </div>
        <p className="max-w-3xl text-xs text-muted-foreground">
          &ldquo;S3&rdquo; is RustFS on one laptop behind a proxy that adds 20 ms per request, not AWS. S3 Tables&apos; managed
          compaction is simulated with its default (binpack, no sort). One dataset, one machine; see the methodology.
        </p>
      </section>
    </div>
  )
}
