import "server-only"
import { execFile } from "node:child_process"
import { access, constants } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

import { connection } from "next/server"

import { quoteIdent, quoteLiteral, quoteTableName } from "@/lib/sql"

import { LakeNotConfiguredError } from "./errors"
import type { LakeBackend, Row, SeriesPlan, SeriesResult, TableInfo } from "./types"

const run = promisify(execFile)

/** The `timelake` CLI binary (cargo build --release -p timelake-cli). */
const BIN =
  process.env.TIMELAKE_BIN ?? path.resolve(/*turbopackIgnore: true*/ process.cwd(), "../target/release/timelake")

/** Warehouse to browse. Defaults to the TSBS IoT tables from the v0 benchmark. */
const WAREHOUSE =
  process.env.TIMELAKE_WAREHOUSE ??
  path.resolve(/*turbopackIgnore: true*/ process.cwd(), "../bench/data/lakes/local/tsbs-iot-standard/timelake/lake")

/** Storage options as "k=v,k=v" (e.g. aws_endpoint=http://localhost:9000,aws_allow_http=true). */
const OPTIONS = (process.env.TIMELAKE_OPTIONS ?? "")
  .split(",")
  .filter(Boolean)
  .flatMap((kv) => ["-o", kv.trim()])

/** Largest CLI output read (a SQL result as JSON lines). */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024

async function exists(p: string, mode: number): Promise<boolean> {
  try {
    await access(p, mode)
    return true
  } catch {
    return false
  }
}

async function ensureConfigured(): Promise<void> {
  await connection() // depends on this machine at request time, not on the build
  if (!(await exists(BIN, constants.X_OK))) {
    throw new LakeNotConfiguredError(`The timelake CLI is not available at ${BIN}.`)
  }
  const local = !WAREHOUSE.includes("://") || WAREHOUSE.startsWith("file://")
  if (local && !(await exists(WAREHOUSE.replace(/^file:\/\//, ""), constants.R_OK))) {
    throw new LakeNotConfiguredError(`The warehouse ${WAREHOUSE} does not exist.`)
  }
}

async function cli(args: string[], input?: string): Promise<string> {
  await ensureConfigured()
  try {
    const child = run(BIN, ["-w", WAREHOUSE, ...OPTIONS, ...args], { maxBuffer: MAX_OUTPUT_BYTES })
    if (input !== undefined) {
      child.child.stdin?.end(input)
    }
    const { stdout } = await child
    return stdout
  } catch (e) {
    const err = e as { stderr?: string; message: string }
    throw new Error((err.stderr || err.message).trim().replace(/^Error: /, ""), { cause: e })
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

async function series({ table, timeColumn, column, bucket, key }: SeriesPlan): Promise<SeriesResult> {
  const c = quoteIdent(column)
  const where = key ? `WHERE ${quoteIdent(key.column)} = ${quoteLiteral(key.value)}` : ""
  const query =
    `SELECT time_bucket(INTERVAL '${bucket}', ${quoteIdent(timeColumn)}) AS t, avg(${c}) AS avg, min(${c}) AS min, max(${c}) AS max, count(*) AS n\n` +
    `FROM ${quoteTableName(table)}\n${where}\nGROUP BY 1 ORDER BY 1`
  const { rows, ms } = await sql(query)
  return { rows: rows as SeriesResult["rows"], ms, query }
}

export const cliBackend: LakeBackend = {
  kind: "cli",
  warehouse: WAREHOUSE,
  capabilities: { sql: true },
  ensureConfigured,
  listTables: async () => JSON.parse(await cli(["ls", "--json"])),
  tableInfo: async (name): Promise<TableInfo> => JSON.parse(await cli(["info", "--json", name])),
  latest: async (name) => parseLines(await cli(["latest", "--format", "json", name])),
  sql,
  series,
}
