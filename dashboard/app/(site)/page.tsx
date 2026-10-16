import { ArrowRight } from "lucide-react"
import Link from "next/link"
import { Suspense } from "react"

import { BenchRanking } from "@/components/bench-ranking"
import { BenefitCards } from "@/components/benefit-cards"
import { GithubIcon } from "@/components/github-icon"
import { StackDiagram } from "@/components/stack-diagram"
import { Button } from "@/components/ui/button"
import { latestByTarget, loadRuns, rankings } from "@/lib/benchmarks"
import { REPO_URL } from "@/lib/site"

const BTN = "font-mono text-xs uppercase tracking-[0.06em]"

/** The dim /\/\ field behind the hero heading: larger than any viewport, centred on it and clipped by its block. */
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

function SectionHead({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h2 className="text-2xl leading-tight font-light tracking-tight">{label}</h2>
      <p className="text-sm text-muted-foreground">{children}</p>
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
    <div className="mx-auto flex max-w-6xl flex-col gap-24 px-4 pt-8 pb-24">
      <div className="flex flex-col gap-8">
        <section className="cells">
          {/* Whole rows (18px) and characters (ch) of the field around the band, so its edges fall between them. */}
          <div className="relative overflow-hidden px-[2ch] py-[36px] font-mono text-xs sm:px-[4ch]">
            <pre aria-hidden className="ascii absolute inset-0 overflow-hidden text-xs leading-[18px]">
              {FIELD}
            </pre>
            <div className="relative flex h-[198px] flex-col justify-center gap-5 bg-card px-6 sm:h-[162px] sm:flex-row sm:items-center sm:justify-between sm:px-8">
              <h1 className="font-sans text-4xl leading-[1.05] font-light tracking-tight sm:text-5xl">
                The open time&#8209;series
                <br />
                lakehouse
              </h1>
              <div className="flex shrink-0 flex-wrap gap-2.5">
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
        </section>
        <BenefitCards />
      </div>

      <section className="flex flex-col gap-6">
        <SectionHead label="How does it work?">
          From the sources that send data to the tools that read it, with only your bucket in between.
        </SectionHead>
        <StackDiagram />
      </section>

      <section className="flex flex-col gap-6">
        <SectionHead label="What is it for?">
          Many series written all the time, and read by more than one tool.
        </SectionHead>
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
      <div className="flex flex-col gap-3">
        <SectionHead label="Benchmarks">
          Measured every week on AWS S3, against other lakes with the same data and queries. Lower is better.
        </SectionHead>
        <nav className="flex flex-wrap gap-x-5 gap-y-1">
          <MoreLink href="/benchmarks">All benchmarks</MoreLink>
          <MoreLink href="/benchmarks/timebench">How we measure</MoreLink>
        </nav>
      </div>
      <div className="grid gap-x-10 gap-y-6 lg:grid-cols-2">
        {rankings(run).map((r) => (
          <BenchRanking key={r.title} ranking={r} />
        ))}
      </div>
    </section>
  )
}
