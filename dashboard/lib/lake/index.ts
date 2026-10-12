import "server-only"

import { cliBackend } from "./cli"
import { wasmBackend } from "./wasm"
import type { LakeBackend, Row, TableInfo } from "./types"

export { LakeInputError, LakeNotConfiguredError, isNotConfigured } from "./errors"
export type { LakeBackend, Row, SeriesPoint, SeriesQuery, SeriesResult, TableInfo } from "./types"

/**
 * The active lake implementation: the WASM client when TIMELAKE_URL is set (hosted, read-only,
 * no SQL), otherwise the timelake CLI (local, full SQL).
 */
const backend: LakeBackend = process.env.TIMELAKE_URL ? wasmBackend : cliBackend

export const WAREHOUSE = backend.warehouse
export const BACKEND = backend.kind
export const SUPPORTS_SQL = backend.capabilities.sql
export const ensureConfigured = () => backend.ensureConfigured()
export const listTables = () => backend.listTables()
export const tableInfo = (name: string) => backend.tableInfo(name)
export const latest = (name: string) => backend.latest(name)
export const sql = (query: string) => backend.sql(query)
export const series = (q: Parameters<LakeBackend["series"]>[0]) => backend.series(q)

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
