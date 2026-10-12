import "server-only"

import { readFile } from "node:fs/promises"
import path from "node:path"

import { connection } from "next/server"

/** Benchmark results bundled with the app (bun run sync-results copies them from ../bench/results). */
const RESULTS = process.env.TIMELAKE_BENCH_RESULTS ?? path.resolve(/*turbopackIgnore: true*/ process.cwd(), "data/results")

export const ENGINES = [
  { id: "v0-timelake", label: "Timelake reader", timelake: true },
  { id: "v0-timelake-duckdb", label: "Timelake tables + DuckDB", timelake: false },
  { id: "v0-lance-df", label: "Lance + DataFusion", timelake: false },
  { id: "v0-lance-duckdb", label: "Lance + DuckDB", timelake: false },
  { id: "v0-iceberg", label: "Iceberg (PyIceberg) + DuckDB", timelake: false },
] as const

export const STATES = [
  { storage: "s3", phase: "ingested", label: "S3 · right after ingest" },
  { storage: "s3", phase: "maintained", label: "S3 · after maintenance" },
  { storage: "local", phase: "ingested", label: "Local disk · right after ingest" },
  { storage: "local", phase: "maintained", label: "Local disk · after maintenance" },
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

export type BenchBar = { engine: string; label: string; timelake: boolean; first: number; best: number }
export type QueryRow = { query: string; times: Record<string, number | null>; rows: Record<string, number | null> }
export type BenchPanel = { suite: string; state: string; bars: BenchBar[]; queries: number; perQuery: QueryRow[] }
export type IngestRow = { storage: string; system: string; seconds: number; p50: number; p95: number; objects: number }
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

type Rec = { engine: string; query: string; status: string; times: number[]; rows?: number; server_ms?: number[]; suite?: string }

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

/** Geometric-mean first-run time per engine, over queries every engine completed (as bench/v0/summarize.py). */
export async function loadPanels(): Promise<BenchPanel[]> {
  await connection()
  const panels: BenchPanel[] = []
  for (const suite of SUITES) {
    for (const st of STATES) {
      const all = await lines<Rec>(`${suite.id}.v0-${st.storage}-${st.phase}.jsonl`)
      const recs = all.filter((r) => r.status === "ok")
      if (recs.length === 0) continue
      const by = new Map(recs.map((r) => [`${r.engine}|${r.query}`, r]))
      const allQueries = [...new Set(all.map((r) => r.query))]
      const queries = allQueries.filter((q) => ENGINES.every((e) => by.has(`${e.id}|${q}`)))
      if (queries.length === 0) continue
      const bars = ENGINES.map((e) => {
        const rs = queries.map((q) => by.get(`${e.id}|${q}`)!)
        return {
          engine: e.id,
          label: e.label,
          timelake: e.timelake,
          first: gm(rs.map((r) => r.times[0])),
          best: gm(rs.map((r) => Math.min(...(r.times.length > 1 ? r.times.slice(1) : r.times)))),
        }
      })
      const perQuery = allQueries.map((q) => ({
        query: q,
        times: Object.fromEntries(ENGINES.map((e) => [e.id, by.get(`${e.id}|${q}`)?.times[0] ?? null])),
        rows: Object.fromEntries(ENGINES.map((e) => [e.id, by.get(`${e.id}|${q}`)?.rows ?? null])),
      }))
      panels.push({ suite: suite.id, state: st.label, bars, queries: queries.length, perQuery })
    }
  }
  return panels
}

export async function loadIngest(): Promise<IngestRow[]> {
  await connection()
  type R = { system: string; storage: string; phase: string; seconds: number; commit_ms_p50: number; commit_ms_p95: number; objects: number }
  const latest = new Map<string, R>()
  for (const r of await lines<R>("v0_ingest.jsonl")) if (r.phase === "ingest") latest.set(`${r.storage}|${r.system}`, r)
  return [...latest.values()]
    .sort((a, b) => b.storage.localeCompare(a.storage) || a.seconds - b.seconds)
    .map((r) => ({ storage: r.storage, system: r.system, seconds: r.seconds, p50: r.commit_ms_p50, p95: r.commit_ms_p95, objects: r.objects }))
}

/** TimescaleDB on Tiger Cloud (bench/results/tsdb_cloud.jsonl), if that run exists. Works with partial data. */
export async function loadTsdb(): Promise<TsdbRow[] | null> {
  await connection()
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
      ["s3-maintained", "Timelake reader · RustFS +20 ms"],
      ["local-maintained", "Timelake reader · local disk"],
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
