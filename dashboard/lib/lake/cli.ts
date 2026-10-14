import "server-only"
import { execFile } from "node:child_process"
import { access, constants } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

import { connection } from "next/server"

import { BUCKETS } from "@/lib/buckets"
import { quoteIdent } from "@/lib/sql-guard"

import { LakeInputError, LakeNotConfiguredError } from "./errors"
import type { LakeBackend, Row, SeriesQuery, SeriesResult, TableInfo } from "./types"

const run = promisify(execFile)

/** The `timelake` CLI binary (cargo build --release -p timelake-cli). */
const BIN =
  process.env.TIMELAKE_BIN ?? path.resolve(/*turbopackIgnore: true*/ process.cwd(), "../target/release/timelake")

/** Warehouse to browse. Defaults to the TSBS IoT tables from the v0 benchmark. */
const WAREHOUSE =
  process.env.TIMELAKE_WAREHOUSE ??
  path.resolve(/*turbopackIgnore: true*/ process.cwd(), "../bench/data/v0/local/timelake/lake")

/** Storage options as "k=v,k=v" (e.g. aws_endpoint=http://localhost:9000,aws_allow_http=true). */
const OPTIONS = (process.env.TIMELAKE_OPTIONS ?? "")
  .split(",")
  .filter(Boolean)
  .flatMap((kv) => ["-o", kv.trim()])

const NUMERIC = /^(Int|UInt|Float|Decimal)/

async function exists(p: string, mode: number): Promise<boolean> {
  try {
    await access(p, mode)
    return true
  } catch {
    return false
  }
}

async function ensureConfigured(): Promise<void> {
  await connection() // depends on this machine, not on build time
  if (!(await exists(BIN, constants.X_OK))) {
    throw new LakeNotConfiguredError(`The timelake CLI is not available at ${BIN}.`)
  }
  const local = !WAREHOUSE.includes("://") || WAREHOUSE.startsWith("file://")
  if (local && !(await exists(WAREHOUSE.replace(/^file:\/\//, ""), constants.R_OK))) {
    throw new LakeNotConfiguredError(`The warehouse ${WAREHOUSE} does not exist.`)
  }
}

async function cli(args: string[], input?: string): Promise<string> {
  await connection() // always read the lake at request time
  await ensureConfigured()
  try {
    const child = run(BIN, ["-w", WAREHOUSE, ...OPTIONS, ...args], { maxBuffer: 256 << 20 })
    if (input !== undefined) {
      child.child.stdin?.end(input)
    }
    const { stdout } = await child
    return stdout
  } catch (e) {
    const err = e as { stderr?: string; message: string }
    throw new Error((err.stderr || err.message).trim().replace(/^Error: /, ""))
  }
}

function parseLines(stdout: string): Row[] {
  return stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Row)
}

async function sql(query: string): Promise<{ rows: Row[]; ms: number }> {
  const t = performance.now()
  const out = await cli(["sql", "--format", "json"], query)
  return { rows: parseLines(out), ms: performance.now() - t }
}

async function tableInfo(name: string): Promise<TableInfo> {
  return JSON.parse(await cli(["info", "--json", name]))
}

async function series({ table, column, bucket, series }: SeriesQuery): Promise<SeriesResult> {
  const info = await tableInfo(table)
  const tc = info.time_column
  const col = info.schema.find((f) => f.name === column && NUMERIC.test(f.type))
  if (!tc || !col) throw new LakeInputError("Pick a numeric column of a time-series table.")
  if (!(BUCKETS as readonly string[]).includes(bucket)) throw new LakeInputError("Unknown bucket.")

  let where = ""
  const key = info.series_key[0]
  if (key && series !== null && series !== "") {
    const keyType = info.schema.find((f) => f.name === key)?.type ?? ""
    let literal: string
    if (NUMERIC.test(keyType)) {
      if (!Number.isFinite(Number(series))) throw new LakeInputError(`${key} must be a number.`)
      literal = String(Number(series))
    } else {
      literal = `'${series.replace(/'/g, "''")}'`
    }
    where = `WHERE ${quoteIdent(key)} = ${literal}`
  }
  const c = quoteIdent(column)
  const query =
    `SELECT time_bucket(INTERVAL '${bucket}', ${quoteIdent(tc)}) AS t, avg(${c}) AS avg, min(${c}) AS min, max(${c}) AS max, count(*) AS n\n` +
    `FROM ${info.name}\n${where}\nGROUP BY 1 ORDER BY 1`
  const { rows, ms } = await sql(query)
  return { rows: rows as SeriesResult["rows"], ms, query }
}

export const cliBackend: LakeBackend = {
  kind: "cli",
  warehouse: WAREHOUSE,
  capabilities: { sql: true },
  ensureConfigured,
  listTables: async () => JSON.parse(await cli(["ls", "--json"])),
  tableInfo,
  latest: async (name) => parseLines(await cli(["latest", "--format", "json", name])),
  sql,
  series,
}
