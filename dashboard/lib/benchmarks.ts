import "server-only"

import { cacheLife } from "next/cache"

import { readFile } from "node:fs/promises"
import path from "node:path"


/** Benchmark results bundled with the app (bun run sync-results copies them from ../bench/results). */
const RESULTS = process.env.TIMELAKE_BENCH_RESULTS ?? path.resolve(/*turbopackIgnore: true*/ process.cwd(), "data/results")

export const ENGINES = [
  { id: "v0-timelake", label: "Timelake reader", timelake: true },
  { id: "v0-timelake-duckdb", label: "Timelake tables + DuckDB", timelake: false },
  { id: "v0-lance-df", label: "Lance + DataFusion", timelake: false },
  { id: "v0-lance-duckdb", label: "Lance + DuckDB", timelake: false },
  { id: "v0-iceberg", label: "Iceberg (PyIceberg) + DuckDB", timelake: false },
  { id: "v0-s3tables", label: "S3 Tables + DuckDB", timelake: false },
] as const

// The real-S3 run (bench/run_aws.sh): a laptop reading S3 in us-east-2. S3 Tables is its own table bucket.
export const STATES = [
  { files: ["v0-laptop-aws-s3-ingested", "v0-laptop-aws-s3tables-ingested"], label: "AWS S3 · right after ingest" },
  { files: ["v0-laptop-aws-s3-maintained", "v0-laptop-aws-s3tables-maintained"], label: "AWS S3 · after compaction" },
  { files: ["v0-laptop-local-ingested"], label: "Local disk · right after ingest" },
  { files: ["v0-laptop-local-maintained"], label: "Local disk · after compaction" },
] as const

export const SUITES = [
  { id: "tsbs_iot", label: "TSBS IoT (12 queries)" },
  { id: "iot_point", label: "Single truck (5 queries)" },
] as const

export const TSDB_ENGINES = [
  { id: "tsdb-hypertable", label: "Hypertable (row store)" },
  { id: "tsdb-columnstore", label: "Hypertable, columnstore (compressed)" },
  { id: "tsdb-tiered", label: "Tiered to S3 (tiered reads)" },
] as const

export type BenchBar = { engine: string; label: string; timelake: boolean; first: number; best: number; requests: number | null }
export type QueryRow = { query: string; times: Record<string, number | null>; rows: Record<string, number | null> }
export type BenchPanel = { suite: string; state: string; bars: BenchBar[]; queries: number; perQuery: QueryRow[] }
export type IngestRow = { storage: string; system: string; seconds: number; p50: number; p95: number; files: number }
export type TsdbRow = {
  suite: string
  engine: string
  label: string
  completed: number
  total: number
  /** Queries completed by every engine with data; the geometric means are over these. */
  common: number
  firstClient: number | null
  firstServer: number | null
  bestServer: number | null
  /** Timelake rows shown for reference (same queries, from the v0 results). */
  reference?: boolean
}

type Rec = {
  engine: string
  query: string
  status: string
  times: number[]
  rows?: number
  requests?: number[]
  server_ms?: number[]
  suite?: string
}

async function lines<T>(file: string): Promise<T[]> {
  try {
    return (await readFile(path.join(/*turbopackIgnore: true*/ RESULTS, file), "utf8"))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as T)
  } catch {
    return []
  }
}

const gm = (xs: number[]) => Math.exp(xs.reduce((s, x) => s + Math.log(Math.max(x, 1e-4)), 0) / xs.length)

/** Geometric-mean first-run time per engine, over queries every engine in the panel completed (as bench/v0/summarize.py). */
export async function loadPanels(): Promise<BenchPanel[]> {
  "use cache" // read at build time: results change only when benchmarks are re-run (then redeploy)
  cacheLife("max")
  const panels: BenchPanel[] = []
  for (const suite of SUITES) {
    for (const st of STATES) {
      const all = (await Promise.all(st.files.map((f) => lines<Rec>(`${suite.id}.${f}.jsonl`)))).flat()
      const recs = all.filter((r) => r.status === "ok")
      if (recs.length === 0) continue
      const by = new Map(recs.map((r) => [`${r.engine}|${r.query}`, r]))
      const engines = ENGINES.filter((e) => recs.some((r) => r.engine === e.id))
      const allQueries = [...new Set(all.map((r) => r.query))]
      const queries = allQueries.filter((q) => engines.every((e) => by.has(`${e.id}|${q}`)))
      if (queries.length === 0) continue
      const bars = engines.map((e) => {
        const rs = queries.map((q) => by.get(`${e.id}|${q}`)!)
        const counted = rs.filter((r) => r.requests?.length)
        return {
          engine: e.id,
          label: e.label,
          timelake: e.timelake,
          first: gm(rs.map((r) => r.times[0])),
          best: gm(rs.map((r) => Math.min(...(r.times.length > 1 ? r.times.slice(1) : r.times)))),
          requests: counted.length === rs.length ? rs.reduce((s, r) => s + r.requests![0], 0) / rs.length : null,
        }
      })
      const perQuery = allQueries.map((q) => ({
        query: q,
        times: Object.fromEntries(engines.map((e) => [e.id, by.get(`${e.id}|${q}`)?.times[0] ?? null])),
        rows: Object.fromEntries(engines.map((e) => [e.id, by.get(`${e.id}|${q}`)?.rows ?? null])),
      }))
      panels.push({ suite: suite.id, state: st.label, bars, queries: queries.length, perQuery })
    }
  }
  return panels
}

type IngestRec = {
  system: string
  storage: string
  phase: string
  seconds: number
  commit_ms_p50: number
  commit_ms_p95: number
  data_files: number
  compaction_after_ingest_s?: Record<string, number>
}

export async function loadIngest(): Promise<IngestRow[]> {
  "use cache" // read at build time: results change only when benchmarks are re-run (then redeploy)
  cacheLife("max")
  const latest = new Map<string, IngestRec>()
  for (const r of await lines<IngestRec>("v0_ingest.laptop.jsonl")) if (r.phase === "ingest") latest.set(`${r.storage}|${r.system}`, r)
  return [...latest.values()]
    .sort((a, b) => b.storage.localeCompare(a.storage) || a.seconds - b.seconds)
    .map((r) => ({ storage: r.storage, system: r.system, seconds: r.seconds, p50: r.commit_ms_p50, p95: r.commit_ms_p95, files: r.data_files }))
}

/** Hours from the end of ingest until S3 Tables' managed compaction had run, per table: [min, max]. */
export async function loadS3TablesDelay(): Promise<[number, number] | null> {
  "use cache"
  cacheLife("max")
  const m = (await lines<IngestRec>("v0_ingest.laptop.jsonl")).findLast((r) => r.system === "s3tables" && r.phase === "maintain")
  const s = Object.values(m?.compaction_after_ingest_s ?? {})
  return s.length ? [Math.min(...s) / 3600, Math.max(...s) / 3600] : null
}

/** TimescaleDB on Tiger Cloud (bench/results/tsdb_cloud.jsonl), if that run exists. Works with partial data. */
export async function loadTsdb(): Promise<TsdbRow[] | null> {
  "use cache" // read at build time: results change only when benchmarks are re-run (then redeploy)
  cacheLife("max")
  const recs = await lines<Rec>("tsdb_cloud.jsonl")
  if (recs.length === 0) return null
  const out: TsdbRow[] = []
  for (const suite of SUITES) {
    const inSuite = recs.filter((r) => r.suite === suite.id)
    if (inSuite.length === 0) continue
    const total = new Set(inSuite.map((r) => r.query)).size
    const okBy = new Map(inSuite.filter((r) => r.status === "ok").map((r) => [`${r.engine}|${r.query}`, r]))
    const withData = TSDB_ENGINES.filter((e) => inSuite.some((r) => r.engine === e.id && r.status === "ok"))
    // Compare like with like: geometric means over the queries every engine with data completed.
    const common = [...new Set(inSuite.map((r) => r.query))].filter((q) => withData.every((e) => okBy.has(`${e.id}|${q}`)))
    for (const e of TSDB_ENGINES) {
      const completed = inSuite.filter((r) => r.engine === e.id && r.status === "ok").length
      const rs = withData.includes(e) ? common.map((q) => okBy.get(`${e.id}|${q}`)!) : []
      const srv = rs.filter((r) => r.server_ms && r.server_ms.length > 0)
      out.push({
        suite: suite.id,
        engine: e.id,
        label: e.label,
        completed,
        total,
        common: common.length,
        firstClient: rs.length ? gm(rs.map((r) => r.times[0])) : null,
        firstServer: srv.length === rs.length && srv.length ? gm(srv.map((r) => r.server_ms![0] / 1000)) : null,
        bestServer:
          srv.length === rs.length && srv.length
            ? gm(srv.map((r) => Math.min(...(r.server_ms!.length > 1 ? r.server_ms!.slice(1) : r.server_ms!)) / 1000))
            : null,
      })
    }
    // Timelake's reader over the same queries, after maintenance, for reference.
    for (const [state, label] of [
      ["laptop-aws-s3-maintained", "Timelake reader · AWS S3 from the same laptop"],
      ["laptop-local-maintained", "Timelake reader · local disk"],
    ] as const) {
      const tl = new Map(
        (await lines<Rec>(`${suite.id}.v0-${state}.jsonl`))
          .filter((r) => r.engine === "v0-timelake" && r.status === "ok")
          .map((r) => [r.query, r]),
      )
      const rs = common.filter((q) => tl.has(q)).map((q) => tl.get(q)!)
      if (rs.length !== common.length || rs.length === 0) continue
      out.push({
        suite: suite.id,
        engine: `timelake-${state}`,
        label,
        completed: tl.size,
        total,
        common: common.length,
        firstClient: gm(rs.map((r) => r.times[0])),
        firstServer: null,
        bestServer: null,
        reference: true,
      })
    }
  }
  return out
}
