import "server-only"

import { readFile } from "node:fs/promises"
import path from "node:path"

import { connection } from "next/server"

const RESULTS = process.env.TIMELAKE_BENCH_RESULTS ?? path.resolve(/*turbopackIgnore: true*/ process.cwd(), "../bench/results")

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

export type BenchBar = { engine: string; label: string; timelake: boolean; first: number; best: number }
export type BenchPanel = { suite: string; state: string; bars: BenchBar[]; queries: number }
export type IngestRow = { storage: string; system: string; seconds: number; p50: number; p95: number; objects: number }

type Rec = { engine: string; query: string; status: string; times: number[] }

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

/** Geometric-mean query time per engine, over queries every engine completed (as v0/summarize.py). */
export async function loadPanels(): Promise<BenchPanel[]> {
  await connection() // results change when benchmarks re-run
  const panels: BenchPanel[] = []
  for (const suite of SUITES) {
    for (const st of STATES) {
      const recs = (await lines<Rec>(`${suite.id}.v0-${st.storage}-${st.phase}.jsonl`)).filter((r) => r.status === "ok")
      if (recs.length === 0) continue
      const by = new Map(recs.map((r) => [`${r.engine}|${r.query}`, r]))
      const queries = [...new Set(recs.map((r) => r.query))].filter((q) => ENGINES.every((e) => by.has(`${e.id}|${q}`)))
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
      panels.push({ suite: suite.id, state: st.label, bars, queries: queries.length })
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
    .sort((a, b) => a.storage.localeCompare(b.storage) || a.seconds - b.seconds)
    .map((r) => ({ storage: r.storage, system: r.system, seconds: r.seconds, p50: r.commit_ms_p50, p95: r.commit_ms_p95, objects: r.objects }))
}
