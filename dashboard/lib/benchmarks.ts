import "server-only"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

import { cacheLife } from "next/cache"

/** Run files bundled with the app (bun run sync-results copies them from ../bench/results/runs). */
const RUNS = process.env.TIMELAKE_BENCH_RUNS ?? path.resolve(/*turbopackIgnore: true*/ process.cwd(), "data/runs")

/** Per-run measurements: the first run, then the repeats. */
type Times = [first: number, ...repeats: number[]]

export type RunHeader = {
  id: string
  workload: string
  scale: string
  params: Record<string, unknown>
  target: string
  storage: string
  machine: string
  commit: string
  dirty: boolean
  label: string
  started: string
  readers: Record<string, string[]>
  versions: Record<string, string>
  runs: number
  live_interval_s?: number
  concurrency?: number[]
  imported?: string
}

export type PhaseRecord = {
  kind: "ingest" | "maintain"
  system: string
  status: string
  error?: string
  seconds?: number
  /** Time spent committing; with pacing, `seconds` is mostly waiting between arrivals. */
  commit_seconds?: number
  commits?: number
  rows?: number
  commit_ms_p50?: number
  commit_ms_p95?: number
  objects?: number | null
  bytes?: number
  data_files?: number
  data_bytes?: number
  requests?: number
  compaction_after_ingest_s?: Record<string, number>
  /** The phase's requests at the store's list prices. */
  usd?: number
  /** Keeping the tables a month at the store's list prices. */
  storage_usd_month?: number
}

/** Fresh readers probing a system while it ingests. */
export type LiveRecord = {
  system: string
  reader: string
  interval_s: number
  rounds: number
  /** Per freshness probe: seconds behind the oldest commit it missed (0 = up to date). */
  lag_s: number[]
  /** Dashboard query -> first-run seconds of each probe. */
  queries: Record<string, number[]>
  errors: string[]
}

/** N dashboard clients querying at once. */
export type ConcurrencyRecord = {
  system: string
  reader: string
  clients: number
  seconds: number
  queries: number
  qps: number
  p50_s?: number
  p95_s?: number
  errors: number
}

export type QueryRecord = {
  system: string
  reader: string
  checkpoint: string
  suite: string
  query: string
  status: string
  error?: string
  times: Times
  rows?: number
  requests?: Times
  server_ms?: Times
  /** The first run's requests at the store's list prices. */
  usd?: number
}

export type Run = {
  header: RunHeader
  phases: PhaseRecord[]
  queries: QueryRecord[]
  live: LiveRecord[]
  concurrency: ConcurrencyRecord[]
  finished: string | null
}

/** The query suites of each timebench workload, as the detail pages group them. */
export const WORKLOADS = [
  {
    id: "tsbs-iot",
    suites: [
      { id: "tsbs_iot", label: "TSBS IoT (12 queries)" },
      { id: "iot_point", label: "Single truck (5 queries)" },
    ],
  },
] as const

export type Workload = (typeof WORKLOADS)[number]

/** How the site names each system and reader pair; a system's own reader comes first. */
const ENGINES: Record<string, string> = {
  "timelake+timelake": "Timelake",
  "timelake+duckdb": "Timelake tables + DuckDB",
  "iceberg+duckdb": "Iceberg (PyIceberg) + DuckDB",
  "s3tables+duckdb": "S3 Tables + DuckDB",
  "lance+duckdb": "Lance + DuckDB",
  "lance+datafusion": "Lance + DataFusion",
  "parquet+duckdb": "Parquet files + DuckDB",
  "parquet+datafusion": "Parquet files + DataFusion",
  "timescaledb+postgres": "TimescaleDB",
}

export const SYSTEMS: Record<string, string> = {
  timelake: "Timelake",
  iceberg: "Iceberg (PyIceberg)",
  s3tables: "S3 Tables (PyIceberg)",
  lance: "Lance",
  parquet: "Parquet files",
  timescaledb: "TimescaleDB",
}

/**
 * Each system's color in charts, fixed so it never changes with what else is shown. S3 Tables and TimescaleDB share
 * one: they never run on the same target (AWS only, and a database server).
 */
export const SYSTEM_COLORS: Record<string, string> = {
  timelake: "var(--chart-1)",
  iceberg: "var(--chart-3)",
  lance: "var(--chart-4)",
  parquet: "var(--chart-5)",
  s3tables: "var(--chart-2)",
  timescaledb: "var(--chart-2)",
}

export const TARGETS: Record<string, string> = {
  "aws-s3": "AWS S3",
  "aws-s3x": "S3 Express One Zone",
  local: "Local disk",
  s3: "Local object store",
  "tiger-cloud": "Tiger Cloud",
}

export const CHECKPOINTS: Record<string, string> = {
  ingested: "Right after ingest",
  maintained: "After maintenance",
}

export const engineLabel = (engine: string) => ENGINES[engine] ?? engine
export const targetLabel = (target: string) => TARGETS[target] ?? target
const engineOrder = (engine: string) => {
  const i = Object.keys(ENGINES).indexOf(engine)
  return i < 0 ? Object.keys(ENGINES).length : i
}

async function readRun(file: string): Promise<Run> {
  const records = (await readFile(path.join(/*turbopackIgnore: true*/ RUNS, file), "utf8"))
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { kind: string } & Record<string, unknown>)
  const end = records.find((r) => r.kind === "end")
  return {
    header: records[0] as unknown as RunHeader,
    phases: records.filter((r) => r.kind === "ingest" || r.kind === "maintain") as unknown as PhaseRecord[],
    queries: records.filter((r) => r.kind === "query") as unknown as QueryRecord[],
    live: records.filter((r) => r.kind === "live") as unknown as LiveRecord[],
    concurrency: records.filter((r) => r.kind === "concurrency") as unknown as ConcurrencyRecord[],
    finished: (end?.finished as string | undefined) ?? null,
  }
}

/** Every run, oldest first. */
export async function loadRuns(): Promise<Run[]> {
  "use cache" // read at build time: runs change only when a benchmark ran (then redeploy)
  cacheLife("max")
  let files: string[]
  try {
    files = (await readdir(/*turbopackIgnore: true*/ RUNS)).filter((f) => f.endsWith(".jsonl")).sort()
  } catch {
    return []
  }
  const runs = await Promise.all(files.map(readRun))
  return runs.sort((a, b) => a.header.started.localeCompare(b.header.started))
}

/** Floor for times in the geometric mean, so a near-zero time doesn't dominate it. */
const MIN_SECONDS = 1e-4

const gm = (xs: number[]) => Math.exp(xs.reduce((s, x) => s + Math.log(Math.max(x, MIN_SECONDS)), 0) / xs.length)

/** The best repeat, or the first run when there were no repeats. */
const best = ([first, ...repeats]: Times) => Math.min(...(repeats.length > 0 ? repeats : [first]))

export type BenchBar = {
  engine: string
  label: string
  timelake: boolean
  first: number
  best: number
  requests: number | null
}
export type QueryRow = { query: string; times: Record<string, number | null>; rows: Record<string, number | null> }
export type BenchPanel = { suite: string; state: string; bars: BenchBar[]; queries: number; perQuery: QueryRow[] }

const engineOf = (q: QueryRecord) => `${q.system}+${q.reader}`

/**
 * One chart per suite and checkpoint: each engine's geometric-mean first run over the queries every engine
 * completed, so the bars compare the same work.
 */
export function panels(run: Run, workload: Workload): BenchPanel[] {
  const out: BenchPanel[] = []
  for (const suite of workload.suites) {
    for (const [checkpoint, label] of Object.entries(CHECKPOINTS)) {
      const all = run.queries.filter((q) => q.suite === suite.id && q.checkpoint === checkpoint)
      const ok = all.filter((q) => q.status === "ok")
      if (ok.length === 0) continue
      const by = new Map(ok.map((q) => [`${engineOf(q)}|${q.query}`, q]))
      const engines = [...new Set(ok.map(engineOf))].sort((a, b) => engineOrder(a) - engineOrder(b))
      const allQueries = [...new Set(all.map((q) => q.query))]
      const common = allQueries.filter((q) => engines.every((e) => by.has(`${e}|${q}`)))
      if (common.length === 0) continue
      const bars = engines.map((e) => {
        const rs = common.flatMap((q) => by.get(`${e}|${q}`) ?? [])
        const requests = rs.map((r) => r.requests?.[0])
        return {
          engine: e,
          label: engineLabel(e),
          timelake: e === "timelake+timelake",
          first: gm(rs.map((r) => r.times[0])),
          best: gm(rs.map((r) => best(r.times))),
          requests: requests.every((n) => n !== undefined) ? requests.reduce((s, n) => s + n, 0) / rs.length : null,
        }
      })
      const perQuery = allQueries.map((q) => ({
        query: q,
        times: Object.fromEntries(engines.map((e) => [e, by.get(`${e}|${q}`)?.times[0] ?? null])),
        rows: Object.fromEntries(engines.map((e) => [e, by.get(`${e}|${q}`)?.rows ?? null])),
      }))
      out.push({ suite: suite.id, state: label, bars, queries: common.length, perQuery })
    }
  }
  return out
}

/** Queries that failed or timed out, as "engine: query (status)". */
export function failures(run: Run): { engine: string; query: string; checkpoint: string; status: string }[] {
  return run.queries
    .filter((q) => q.status !== "ok")
    .map((q) => ({ engine: engineLabel(engineOf(q)), query: q.query, checkpoint: q.checkpoint, status: q.status }))
}

/** The newest run of a workload on each target, newest target first. */
export function latestByTarget(runs: Run[], workload: string): Run[] {
  const latest = new Map<string, Run>()
  for (const r of runs) if (r.header.workload === workload) latest.set(r.header.target, r)
  const order = Object.keys(TARGETS)
  return [...latest.values()].sort((a, b) => order.indexOf(a.header.target) - order.indexOf(b.header.target))
}

export type HistoryPoint = { run: string; date: string; commit: string } & Record<string, number | string>

/**
 * Each system's own reader over time on one target: geometric-mean first run over all of a run's queries that it
 * completed at a checkpoint. A line is one engine; a point is one run.
 */
export function history(
  runs: Run[],
  workload: string,
  target: string,
  checkpoint: string,
): { points: HistoryPoint[]; engines: string[] } {
  const points: HistoryPoint[] = []
  const engines = new Set<string>()
  for (const r of runs) {
    if (r.header.workload !== workload || r.header.target !== target) continue
    const point: HistoryPoint = { run: r.header.id, date: r.header.started.slice(0, 10), commit: r.header.commit }
    for (const [system, readers] of Object.entries(r.header.readers)) {
      const engine = `${system}+${readers[0]}`
      const rs = r.queries.filter((q) => engineOf(q) === engine && q.checkpoint === checkpoint && q.status === "ok")
      if (rs.length === 0) continue
      point[engine] = gm(rs.map((q) => q.times[0]))
      engines.add(engine)
    }
    points.push(point)
  }
  return { points, engines: [...engines].sort((a, b) => engineOrder(a) - engineOrder(b)) }
}

/** Hours from the end of ingest until S3 Tables' managed compaction had run, per table: [min, max]. */
export function s3TablesDelay(run: Run): [number, number] | null {
  const m = run.phases.find((p) => p.system === "s3tables" && p.kind === "maintain")
  const s = Object.values(m?.compaction_after_ingest_s ?? {})
  return s.length ? [Math.min(...s) / 3600, Math.max(...s) / 3600] : null
}

export type Rank = { key: string; label: string; system: string; value: number; timelake: boolean }
export type Ranking = { title: string; note: string; unit: "seconds" | "milliseconds"; rows: Rank[] }

/**
 * The top-level results of a run: query time after maintenance and right after ingest (geometric mean of first runs
 * over every query all readers completed), then median commit time. Fastest first.
 */
export function rankings(run: Run): Ranking[] {
  const out: Ranking[] = []
  for (const [checkpoint, label] of Object.entries(CHECKPOINTS).toReversed()) {
    const ok = run.queries.filter((q) => q.checkpoint === checkpoint && q.status === "ok")
    const engines = [...new Set(ok.map(engineOf))]
    if (engines.length < 2) continue
    const by = new Map(ok.map((q) => [`${engineOf(q)}|${q.suite}|${q.query}`, q]))
    const all = [...new Set(run.queries.filter((q) => q.checkpoint === checkpoint).map((q) => `${q.suite}|${q.query}`))]
    const common = all.filter((q) => engines.every((e) => by.has(`${e}|${q}`)))
    if (common.length === 0) continue
    out.push({
      title: `Queries, ${label.toLowerCase()}`,
      note: `first run, geometric mean of ${common.length} queries`,
      unit: "seconds",
      rows: engines
        .map((e) => ({
          key: e,
          label: engineLabel(e),
          system: e.split("+", 1)[0] ?? e,
          value: gm(common.flatMap((q) => by.get(`${e}|${q}`)?.times[0] ?? [])),
          timelake: e === "timelake+timelake",
        }))
        .sort((a, b) => a.value - b.value),
    })
  }
  const ingest = run.phases.filter((p) => p.kind === "ingest" && p.status === "ok" && p.commit_ms_p50 != null)
  if (ingest.length > 1) {
    out.push({
      title: "Commit",
      note: "median time per commit while streaming",
      unit: "milliseconds",
      rows: ingest
        .map((p) => ({
          key: p.system,
          label: SYSTEMS[p.system] ?? p.system,
          system: p.system,
          value: p.commit_ms_p50 ?? 0,
          timelake: p.system === "timelake",
        }))
        .sort((a, b) => a.value - b.value),
    })
  }
  return out
}

const median = (xs: number[]) => {
  const sorted = xs.toSorted((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

export type LiveRow = { system: string; probes: number; behind: number; maxLag: number; queryMedian: number | null }

/** While ingesting: how often fresh readers were behind, and the dashboard queries' median first run. */
export function liveRows(run: Run): LiveRow[] {
  return run.live.map((r) => {
    const times = Object.values(r.queries).flat()
    return {
      system: r.system,
      probes: r.lag_s.length,
      behind: r.lag_s.filter((x) => x > 0).length,
      maxLag: Math.max(0, ...r.lag_s),
      queryMedian: times.length ? median(times) : null,
    }
  })
}

export type CostRow = {
  system: string
  ingestMonth: number | null
  storageMonth: number | null
  perMillionQueries: number | null
}

/**
 * At the store's list prices: ingest requests scaled to a month at the run's data rate, storage after maintenance per
 * month, and a million first-run queries on the system's own reader after maintenance.
 */
export function costRows(run: Run): CostRow[] {
  const span = Number(run.header.params.span_days ?? 3)
  const rows: CostRow[] = []
  for (const system of Object.keys(run.header.readers)) {
    const ingest = run.phases.find((p) => p.kind === "ingest" && p.system === system)
    const maintain = run.phases.find((p) => p.kind === "maintain" && p.system === system)
    const own = `${system}+${run.header.readers[system]?.[0]}`
    const costs = run.queries.flatMap((q) =>
      engineOf(q) === own && q.checkpoint === "maintained" && q.usd != null ? [q.usd] : [],
    )
    const row = {
      system,
      ingestMonth: ingest?.usd != null ? (ingest.usd * 30) / span : null,
      storageMonth: (maintain ?? ingest)?.storage_usd_month ?? null,
      perMillionQueries: costs.length ? (costs.reduce((a, b) => a + b, 0) / costs.length) * 1e6 : null,
    }
    if (row.ingestMonth != null || row.storageMonth != null || row.perMillionQueries != null) rows.push(row)
  }
  return rows
}
