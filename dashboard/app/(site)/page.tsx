import Link from "next/link"
import {
  ArrowRight,
  Boxes,
  Database,
  FileStack,
  Gauge,
  GitCommitHorizontal,
  Layers,
  Rows3,
  ScanSearch,
  Timer,
  Wrench,
} from "lucide-react"

import { ArchitectureDiagram } from "@/components/architecture-diagram"
import { CodeBlock } from "@/components/code-block"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

const PROBLEMS = [
  {
    icon: FileStack,
    title: "Frequent appends make small files",
    body: "Streaming 5-minute batches into an Iceberg table (the S3 Tables + Firehose pattern) leaves one file and one manifest per commit. In our test that was 864 files and 864 manifests per table after three days. Readers fetch all of them.",
  },
  {
    icon: Wrench,
    title: "Maintenance is a separate system",
    body: "Compaction, re-sorting, retention and snapshot expiry run as Glue or Spark jobs that someone schedules, sizes, pays for and debugs. Until they run, queries pay for the raw layout.",
  },
  {
    icon: Timer,
    title: "Generic engines don't know it's time series",
    body: "\"Latest value per device\" scans the whole table. A query for one device in the last hour still opens files for every device, because nothing sorted or indexed the data by series.",
  },
]

const HOW = [
  {
    icon: GitCommitHorizontal,
    title: "A catalog that is just files",
    body: "Each commit writes vN.metadata.json with put-if-absent (S3 If-None-Match and equivalents). Exactly one concurrent writer wins; the others rebase and retry. No catalog server, no database.",
  },
  {
    icon: Rows3,
    title: "A time-series contract",
    body: "Declare a time column and a series key, like a TimescaleDB hypertable. Tables are partitioned by hour, day or month and every file is sorted by (series key, time).",
  },
  {
    icon: Layers,
    title: "Maintenance inside the writer",
    body: "After an append, size-tiered compaction merges groups of similar-sized small files, and old snapshots expire in batches. timelake maintain rewrites each partition into one sorted, deduplicated file and applies retention.",
  },
  {
    icon: Database,
    title: "A last-value index",
    body: "Every append updates a small Parquet file with the newest row per series, referenced from the snapshot. \"Latest per device\" becomes one small read instead of a scan.",
  },
  {
    icon: ScanSearch,
    title: "A reader that knows the layout",
    body: "A DataFusion table provider prunes files on Iceberg column bounds, rewrites latest-row queries to the index, loads all of a query's tables concurrently and reads each Parquet footer once.",
  },
  {
    icon: Boxes,
    title: "Plain Iceberg + Parquet on disk",
    body: "Tables are Iceberg v2 with Parquet data files in the Hadoop-catalog layout (vN.metadata.json + version-hint.text). DuckDB's iceberg_scan reads them without Timelake installed.",
  },
]

const HIGHLIGHTS = [
  { value: "3.7–16×", label: "faster TSBS IoT queries on S3 right after streaming ingest", detail: "0.28 s vs 1.05–4.50 s, first run" },
  { value: "1.2–1.5×", label: "faster after every system's own compaction", detail: "0.29 s vs 0.36–0.42 s, first run" },
  { value: "12 vs 1,733", label: "requests for \"latest position per truck\" on S3 after streaming ingest", detail: "Timelake vs naive Iceberg (Lance: 3,614)" },
  { value: "434 s", label: "to stream 1,728 commits to S3, compaction included", detail: "Lance 817 s, PyIceberg 1,607 s" },
]

export default function Home() {
  return (
    <div className="mx-auto max-w-6xl px-4">
      {/* Hero */}
      <section className="py-16 sm:py-24">
        <Badge variant="secondary" className="mb-6">
          v0 · private preview
        </Badge>
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">A serverless time-series lake on Apache Iceberg</h1>
        <p className="mt-6 max-w-2xl text-lg text-muted-foreground">
          Timelake stores time series as open Iceberg tables on any object store, keeps them sorted and compacted without
          external jobs, and reads them with a query engine that knows what a series is. There is no server and no database
          to run.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button size="lg" render={<Link href="/docs/quick-start" />}>
            Quick start <ArrowRight />
          </Button>
          <Button size="lg" variant="outline" render={<Link href="/benchmarks" />}>
            <Gauge /> Benchmarks
          </Button>
          <Button size="lg" variant="ghost" render={<Link href="/explore" />}>
            <Database /> Explorer
          </Button>
        </div>
      </section>

      {/* Problem */}
      <section className="py-12">
        <h2 className="text-2xl font-semibold tracking-tight">The problem with time series on a lake today</h2>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Teams put telemetry in S3 Tables or self-managed Iceberg because it is cheap, durable and readable by every engine.
          Then they write custom jobs to make it fast.
        </p>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {PROBLEMS.map((p) => (
            <Card key={p.title}>
              <CardHeader>
                <p.icon className="mb-2 size-5 text-muted-foreground" />
                <CardTitle>{p.title}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">{p.body}</CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* How */}
      <section className="py-12">
        <h2 className="text-2xl font-semibold tracking-tight">How Timelake works</h2>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          A Rust library with a CLI and a Python package. Writers, maintenance and readers are all stateless: everything
          durable is in object storage.
        </p>
        <Card className="mt-8">
          <CardContent className="overflow-x-auto">
            <div className="min-w-[720px]">
              <ArchitectureDiagram />
            </div>
          </CardContent>
        </Card>
        <div className="mt-8 grid gap-x-8 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {HOW.map((h) => (
            <div key={h.title}>
              <h.icon className="mb-3 size-5 text-[var(--chart-1)]" />
              <h3 className="font-medium">{h.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{h.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Quick start */}
      <section className="py-12">
        <h2 className="text-2xl font-semibold tracking-tight">Quick start</h2>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Point it at a local directory or an <code className="font-mono text-sm">s3://</code>, <code className="font-mono text-sm">gs://</code> or{" "}
          <code className="font-mono text-sm">az://</code> location.
        </p>
        <Tabs defaultValue="cli" className="mt-6">
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
      <section className="py-12">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Benchmark highlights</h2>
            <p className="mt-2 max-w-3xl text-muted-foreground">
              TSBS IoT data (23.3M rows) streamed as 1,728 five-minute micro-batches into Timelake, Lance and naive Iceberg
              (PyIceberg appends, the S3 Tables write pattern), then queried with the 12 TSBS IoT queries.
            </p>
          </div>
          <Button variant="outline" render={<Link href="/benchmarks" />}>
            All results <ArrowRight />
          </Button>
        </div>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {HIGHLIGHTS.map((h) => (
            <Card key={h.label}>
              <CardHeader>
                <CardTitle className="font-mono text-2xl tabular-nums">{h.value}</CardTitle>
                <CardDescription className="text-foreground">{h.label}</CardDescription>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">{h.detail}</CardContent>
            </Card>
          ))}
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          &ldquo;S3&rdquo; is RustFS on one laptop behind a proxy that adds 20 ms per request, not AWS. S3 Tables&apos; managed
          compaction is simulated with its default (binpack, no sort). One dataset, one machine; see the methodology.
        </p>
      </section>

      <Separator className="my-8" />

      {/* Compatibility */}
      <section className="grid gap-8 pb-20 md:grid-cols-2">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Open by default</h2>
          <p className="mt-2 text-muted-foreground">
            Every byte is Iceberg metadata and Parquet. Plain DuckDB reads Timelake tables with identical results (checked on
            every benchmark query), and the last-value index is a Parquet file any engine can read.
          </p>
        </div>
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Runs where your data is</h2>
          <p className="mt-2 text-muted-foreground">
            S3 and S3-compatible stores, Google Cloud Storage, Azure Blob Storage, or a local directory. Commits need
            conditional writes (put-if-absent). Tested so far on local disk and RustFS.
          </p>
          <Button variant="link" className="mt-2 px-0" render={<Link href="/docs/storage" />}>
            Storage & configuration <ArrowRight />
          </Button>
        </div>
      </section>
    </div>
  )
}
