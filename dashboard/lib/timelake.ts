import "server-only"

import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"

import { connection } from "next/server"

const run = promisify(execFile)

/** The `timelake` CLI binary (cargo build --release -p timelake-cli). */
const BIN = process.env.TIMELAKE_BIN ?? path.resolve(/*turbopackIgnore: true*/ process.cwd(), "../target/release/timelake")

/** Warehouse to browse. Defaults to the TSBS IoT tables from the v0 benchmark. */
export const WAREHOUSE =
  process.env.TIMELAKE_WAREHOUSE ?? path.resolve(/*turbopackIgnore: true*/ process.cwd(), "../bench/data/v0/local/timelake/lake")

/** Storage options as "k=v,k=v" (e.g. aws_endpoint=http://localhost:9000,aws_allow_http=true). */
const OPTIONS = (process.env.TIMELAKE_OPTIONS ?? "")
  .split(",")
  .filter(Boolean)
  .flatMap((kv) => ["-o", kv.trim()])

export type Row = Record<string, unknown>

export type TableInfo = {
  name: string
  version: number
  location: string
  format_version: string
  time_column: string | null
  series_key: string[]
  chunk: string | null
  dedup: boolean
  retention_days: number | null
  schema: { name: string; type: string; nullable: boolean }[]
  rows: number
  files: number
  bytes: number
  manifests: number
  snapshot_count: number
  last_commit_ms: number | null
  last_value_index: string | null
  partitions: { partition: string; files: number; rows: number; bytes: number }[]
  snapshots: {
    id: string
    timestamp_ms: number
    operation: string
    added_records: number
    deleted_records: number
    added_files: number
    deleted_files: number
    total_records: number
  }[]
}

async function cli(args: string[], input?: string): Promise<string> {
  await connection() // always read the lake at request time
  try {
    const child = run(BIN, ["-w", WAREHOUSE, ...OPTIONS, ...args], { maxBuffer: 256 << 20 })
    if (input !== undefined) {
      child.child.stdin?.end(input)
    }
    const { stdout } = await child
    return stdout
  } catch (e) {
    const err = e as { stderr?: string; message: string; code?: string }
    if (err.code === "ENOENT") {
      throw new Error(`timelake CLI not found at ${BIN}. Build it with: cargo build --release -p timelake-cli`)
    }
    throw new Error((err.stderr || err.message).trim().replace(/^Error: /, ""))
  }
}

function parseLines(stdout: string): Row[] {
  return stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Row)
}

export async function listTables(): Promise<string[]> {
  return JSON.parse(await cli(["ls", "--json"]))
}

export async function tableInfo(name: string): Promise<TableInfo> {
  return JSON.parse(await cli(["info", "--json", name]))
}

export async function latest(name: string): Promise<Row[]> {
  return parseLines(await cli(["latest", "--format", "json", name]))
}

/** Runs one SQL statement; returns rows and the wall time including process start. */
export async function sql(query: string): Promise<{ rows: Row[]; ms: number }> {
  const t = performance.now()
  const out = await cli(["sql", "--format", "json"], query)
  return { rows: parseLines(out), ms: performance.now() - t }
}

/** All tables with their details, and when they were read (for "x ago" labels). */
export async function loadTables(): Promise<{ tables: TableInfo[]; now: number }> {
  const tables = await Promise.all((await listTables()).map(tableInfo))
  return { tables, now: Date.now() }
}

/** One table's details, latest values (for time-series tables), and when they were read. */
export async function loadTable(name: string): Promise<{ info: TableInfo; latestRows: Row[]; now: number }> {
  const info = await tableInfo(name)
  const latestRows = info.time_column ? await latest(name) : []
  return { info, latestRows, now: Date.now() }
}

/** Runs a loader, returning its value or the error (so pages render errors without try/catch JSX). */
export async function attempt<T>(f: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await f() }
  } catch (error) {
    return { ok: false, error }
  }
}
