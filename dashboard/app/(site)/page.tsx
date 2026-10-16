import { ArrowRight } from "lucide-react"
import Link from "next/link"
import { Suspense } from "react"

import { BenchRanking } from "@/components/bench-ranking"
import { WORDMARK } from "@/components/brand/mark-geometry"
import { TimelakeMark } from "@/components/brand/timelake-mark"
import { GithubIcon } from "@/components/github-icon"
import { StackDiagram } from "@/components/stack-diagram"
import { Button } from "@/components/ui/button"
import { latestByTarget, loadRuns, rankings } from "@/lib/benchmarks"
import { REPO_URL } from "@/lib/site"

const BTN = "font-mono text-xs uppercase tracking-[0.06em]"

/** The dim /\/\ field behind the hero lockup: larger than any viewport, centred on the lockup and clipped by its block. */
const FIELD = Array.from({ length: 40 }, (_, r) => (r % 2 ? "\\/" : "/\\").repeat(120)).join("\n")

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

function SectionHead({ label }: { label: string }) {
  return <h2 className="text-2xl leading-tight font-light tracking-tight">{label}</h2>
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
            The serverless
            <br />
            time&#8209;series
            <br />
            lakehouse
          </h1>
          <div className="label-mono">Open source · Apache 2.0 · Iceberg compatible</div>
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
        <SectionHead label="How does it work?" />
        <StackDiagram />
      </section>

      <section className="flex flex-col gap-6">
        <SectionHead label="What is it for?" />
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
    </div>
  )
}

/** The latest weekly run of TSBS IoT on S3: what was measured, and the results. */
async function Measurements() {
  const run = latestByTarget(await loadRuns(), "tsbs-iot").find(
    (r) => r.header.target === "aws-s3" && !r.header.variant,
  )
  if (!run) return null
  return (
    <section className="flex flex-col gap-6">
      <SectionHead label="How fast is it?" />
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
