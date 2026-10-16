import {
  ArrowRight,
  Bot,
  BotMessageSquare,
  BrainCircuit,
  ChartCandlestick,
  Factory,
  type LucideIcon,
  Server,
  Truck,
  Zap,
} from "lucide-react"
import Link from "next/link"
import { Suspense } from "react"

import { BenchCards } from "@/components/bench-cards"
import { BenefitCards } from "@/components/benefit-cards"
import { GithubIcon } from "@/components/github-icon"
import { StackDiagram } from "@/components/stack-diagram"
import { Button } from "@/components/ui/button"
import { type ArtKind, UseCaseArt } from "@/components/use-case-art"
import { latestByTarget, loadRuns } from "@/lib/benchmarks"
import { REPO_URL } from "@/lib/site"

const BTN = "font-mono text-xs uppercase tracking-[0.06em]"

/** The dim /\/\ field behind the hero heading: larger than any viewport, centred on it and clipped by its block. */
const FIELD = Array.from({ length: 40 }, (_, r) => (r % 2 ? "\\/" : "/\\").repeat(120)).join("\n")

/** What Timelake is for, each with a picture drawn in squares. */
const USE_CASES: { icon: LucideIcon; art: ArtKind; title: string; body: string }[] = [
  {
    icon: Factory,
    art: "sensors",
    title: "Industrial sensors",
    body: "Thousands of tags sampled every second to every minute, from gateways that send their backlog after going offline.",
  },
  {
    icon: Truck,
    art: "fleet",
    title: "Vehicle fleets",
    body: "Position and diagnostics from thousands of vehicles and devices, every few seconds.",
  },
  {
    icon: Bot,
    art: "robot",
    title: "Robotics",
    body: "Joint positions, torques and sensor readings from robots, recorded at high rates and replayed by time range.",
  },
  {
    icon: ChartCandlestick,
    art: "market",
    title: "Financial data",
    body: "Prices and trades for thousands of instruments, read as time ranges, bars and the latest price.",
  },
  {
    icon: Server,
    art: "metrics",
    title: "Server metrics",
    body: "CPU, memory and disk metrics from thousands of hosts.",
  },
  {
    icon: BrainCircuit,
    art: "ml",
    title: "Data science and ML",
    body: "Time series pulled into notebooks as Arrow tables, for pandas, polars and model training, straight from the bucket.",
  },
  {
    icon: Zap,
    art: "functions",
    title: "Serverless functions",
    body: "Lambda functions and short jobs that start, append or query, and exit. There are no connections to pool and no database to size.",
  },
  {
    icon: BotMessageSquare,
    art: "agents",
    title: "AI agents",
    body: "Agents can query as often as they like: reads go to object storage, so there is no database for them to overload.",
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
        <SectionHead label="What is it for?">
          Many series written all the time, and read by more than one tool.
        </SectionHead>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {USE_CASES.map((u) => {
            const Icon = u.icon
            return (
              <div key={u.title} data-use-case className="flex flex-col gap-2 rounded-lg border bg-card p-6">
                <div className="mb-3">
                  <UseCaseArt kind={u.art} />
                </div>
                <h3 className="flex items-center gap-2.5 text-lg font-normal">
                  <Icon className="size-4.5 shrink-0 text-muted-foreground" aria-hidden />
                  {u.title}
                </h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{u.body}</p>
              </div>
            )
          })}
        </div>
      </section>

      <section className="flex flex-col gap-6">
        <SectionHead label="Architecture">
          From the sources that send data to the tools that read it, with only your bucket in between.
        </SectionHead>
        <StackDiagram />
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
      <BenchCards run={run} />
    </section>
  )
}
