import "server-only"
import { cliBackend } from "./cli"
import { LakeInputError } from "./errors"
import {
  isNumericType,
  type LakeBackend,
  type Row,
  type SeriesPlan,
  type SeriesQuery,
  type SeriesResult,
  type TableInfo,
} from "./types"
import { wasmBackend } from "./wasm"

/**
 * The active lake implementation: the WASM client when TIMELAKE_URL is set (hosted, read-only,
 * no SQL), otherwise the timelake CLI (local, full SQL).
 */
const backend: LakeBackend = process.env.TIMELAKE_URL ? wasmBackend : cliBackend

export const WAREHOUSE = backend.warehouse
export const SUPPORTS_SQL = backend.capabilities.sql
export const ensureConfigured = () => backend.ensureConfigured()
export const sql = (query: string) => backend.sql(query)

/** Checks a chart request against the table's schema, then runs it. */
export async function series({ table, column, bucket, series: value }: SeriesQuery): Promise<SeriesResult> {
  const info = await backend.tableInfo(table)
  const timeColumn = info.time_column
  if (!timeColumn || !info.schema.some((f) => f.name === column && isNumericType(f.type))) {
    throw new LakeInputError("Pick a numeric column of a time-series table.")
  }
  const keyColumn = info.series_key[0]
  let key: SeriesPlan["key"] = null
  if (keyColumn && value) {
    const keyType = info.schema.find((f) => f.name === keyColumn)?.type ?? ""
    if (!isNumericType(keyType)) key = { column: keyColumn, value }
    else if (Number.isFinite(Number(value))) key = { column: keyColumn, value: Number(value) }
    else throw new LakeInputError(`${keyColumn} must be a number.`)
  }
  return backend.series({ table: info.name, timeColumn, column, bucket, key })
}

/** All tables with their details, and when they were read (for "x ago" labels). */
export async function loadTables(): Promise<{ tables: TableInfo[]; now: number }> {
  const tables = await Promise.all((await backend.listTables()).map((name) => backend.tableInfo(name)))
  return { tables, now: Date.now() }
}

/**
 * One table's details, its latest values (time-series tables only; null otherwise), and when they were read. Latest
 * values can fail on their own (the hosted reader needs a last-value index), without failing the rest.
 */
export async function loadTable(
  name: string,
): Promise<{ info: TableInfo; latest: Attempt<Row[]> | null; now: number }> {
  const info = await backend.tableInfo(name)
  const latest = info.time_column ? await attempt(() => backend.latest(name)) : null
  return { info, latest, now: Date.now() }
}

export type Attempt<T> = { ok: true; value: T } | { ok: false; error: unknown }

/** Runs a loader, returning its value or the error (so pages render errors without try/catch JSX). */
export async function attempt<T>(f: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await f() }
  } catch (error) {
    return { ok: false, error }
  }
}
