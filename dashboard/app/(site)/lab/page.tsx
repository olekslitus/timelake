import { readFile } from "node:fs/promises"
import path from "node:path"

import { ArrowRight } from "lucide-react"
import type { Metadata } from "next"
import { cacheLife } from "next/cache"
import Link from "next/link"
import { Suspense } from "react"

import { GithubIcon } from "@/components/github-icon"
import { BucketAnimation } from "@/components/lab/bucket-animation"
import { LiveStripChart } from "@/components/lab/live-strip-chart"
import { type Racer, RequestRace } from "@/components/lab/request-race"
import { SeriesField } from "@/components/lab/series-field"
import { StripChart } from "@/components/lab/strip-chart"
import { type Snapshot, TimeTravel } from "@/components/lab/time-travel"
import { TypedTerminal } from "@/components/lab/typed-terminal"
import { Button } from "@/components/ui/button"
import { engineLabel, latestByTarget, loadRuns } from "@/lib/benchmarks"
import { REPO_URL } from "@/lib/site"

/** Visual ideas for the home page, side by side. Not linked from the site. */
export const metadata: Metadata = { title: "Lab", robots: { index: false } }

const BTN = "font-mono text-xs uppercase tracking-[0.06em]"

/** The demo table that the live chart and the time-travel slider read (written with the CLI). */
const DEMO = path.resolve(/*turbopackIgnore: true*/ process.cwd(), "public/lab-lake/demo/readings/metadata")

/** The hero's heading and buttons, on a panel over a moving background. */
function HeroPanel() {
  return (
    <div className="absolute inset-y-0 left-0 flex items-center p-6 sm:p-8">
      <div className="flex flex-col gap-5 rounded-md border bg-card/90 p-6 backdrop-blur-sm">
        <h1 className="text-4xl leading-[1.05] font-light tracking-tight sm:text-5xl">
          Your time&#8209;series
          <br />
          lakehouse
        </h1>
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
    </div>
  )
}

function Idea({ n, title, children, note }: { n: number; title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <div className="label-mono">Idea {n}</div>
        <h2 className="text-2xl leading-tight font-light tracking-tight">{title}</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">{note}</p>
      </div>
      {children}
    </section>
  )
}

export default function Lab() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-20 px-4 pt-10 pb-24 sm:pt-16">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-light tracking-tight">Lab</h1>
        <p className="max-w-3xl text-muted-foreground">
          Visual ideas for the home page, to compare side by side. The first four are hero backgrounds; the last three
          are for the sections below it.
        </p>
      </div>

      <Idea
        n={1}
        title="Strip-chart recorder"
        note="Chart paper with a pen trace that the paper carries to the left, like the instruments that recorded time series before screens. Generated data."
      >
        <div className="cells">
          <StripChart>
            <HeroPanel />
          </StripChart>
        </div>
      </Idea>

      <Idea
        n={2}
        title="The recorder, drawing real data read in your browser"
        note="The same recorder, but the trace is a week of a sensor's 10-minute averages read from a real Timelake table in this browser with @timelake/client. The readout in the corner says what the read took. The table is in public/lab-lake (written with the CLI); on the live site it would sit in a public bucket."
      >
        <div className="cells">
          <LiveStripChart>
            <HeroPanel />
          </LiveStripChart>
        </div>
      </Idea>

      <Idea
        n={3}
        title="A field of series"
        note="The mark's idea as a background: parallel lines that turn together at sharp corners, like readings from one machine, drifting slowly. One line is in the accent."
      >
        <div className="cells">
          <SeriesField>
            <HeroPanel />
          </SeriesField>
        </div>
      </Idea>

      <Idea
        n={4}
        title="Typed terminal"
        note="The quick start typed out, one command at a time, with the CLI's real output. Could sit next to the heading in the hero."
      >
        <TypedTerminal />
      </Idea>

      <Idea
        n={5}
        title="A bucket that maintains itself"
        note="For “How does it work?”: appends add small files, the writer merges them, retention drops the oldest day, and each commit writes new metadata and a new head. Illustrative names and sizes."
      >
        <BucketAnimation />
      </Idea>

      <Suspense fallback={null}>
        <Race />
      </Suspense>

      <Suspense fallback={null}>
        <Travel />
      </Suspense>
    </div>
  )
}

/** "Latest position of every truck", right after ingest, in the newest weekly S3 run. */
async function Race() {
  const run = latestByTarget(await loadRuns(), "tsbs-iot").find(
    (r) => r.header.target === "aws-s3" && !r.header.variant,
  )
  if (!run) return null
  const engines = ["timelake+timelake", "lance+duckdb", "iceberg+duckdb", "parquet+duckdb"]
  const racers: Racer[] = engines.flatMap((e) => {
    const q = run.queries.find(
      (x) =>
        `${x.system}+${x.reader}` === e && x.query === "last-loc" && x.checkpoint === "ingested" && x.status === "ok",
    )
    const requests = q?.requests?.[0]
    return q && requests !== undefined
      ? [{ label: engineLabel(e), requests, seconds: q.times[0], timelake: e === "timelake+timelake" }]
      : []
  })
  const trucks = run.queries.find((q) => q.query === "last-loc" && q.system === "timelake")?.rows
  return (
    <Idea
      n={6}
      title="Request race"
      note="For “How fast is it?”: one query on every system, each request a dot, at the pace the weekly run measured (sped up). Real numbers."
    >
      <RequestRace
        racers={racers}
        caption={`Latest position of ${trucks?.toLocaleString("en") ?? "every"} trucks, right after ingest. TSBS IoT on AWS S3, run of ${run.header.started.slice(0, 10)}; times are the first run.`}
      />
    </Idea>
  )
}

/** The demo table's snapshots, from its current metadata file. */
async function loadSnapshots(): Promise<{ snapshots: Snapshot[]; days: string[] }> {
  "use cache"
  cacheLife("max")
  const version = (await readFile(path.join(DEMO, "version-hint.text"), "utf8")).trim()
  // Snapshot ids don't fit in a JavaScript number; keep them as strings.
  const text = (await readFile(path.join(DEMO, `v${version}.metadata.json`), "utf8")).replace(
    /"snapshot-id"\s*:\s*(\d+)/g,
    '"snapshot-id":"$1"',
  )
  const meta = JSON.parse(text) as {
    snapshots: { "snapshot-id": string; "sequence-number": number; summary: Record<string, string> }[]
  }
  const snapshots = meta.snapshots
    .map((s) => ({
      // Version 1 is the empty table; each commit after it adds one.
      version: s["sequence-number"] + 1,
      id: s["snapshot-id"],
      operation: s.summary.operation ?? "",
      added: Number(s.summary["added-records"] ?? 0),
      rows: Number(s.summary["total-records"] ?? 0),
      files: Number(s.summary["total-data-files"] ?? 0),
    }))
    .sort((a, b) => a.version - b.version)
  const days = Array.from({ length: Math.max(...snapshots.map((s) => s.files)) }, (_, i) =>
    new Date(Date.UTC(2026, 9, 9 + i)).toISOString().slice(0, 10),
  )
  return { snapshots, days }
}

async function Travel() {
  const { snapshots, days } = await loadSnapshots()
  return (
    <Idea
      n={7}
      title="Time travel"
      note="Every commit is a version of the table. Drag through the demo table's seven commits (a day each); the numbers come from its Iceberg metadata, and any version can be made current again with timelake rollback."
    >
      <TimeTravel snapshots={snapshots} days={days} />
    </Idea>
  )
}
