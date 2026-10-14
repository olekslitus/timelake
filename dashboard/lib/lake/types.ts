import type { Bucket } from "@/lib/buckets"

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

const NUMERIC_TYPE = /^(Int|UInt|Float|Decimal)/

/** Whether a column type (its Arrow name, as in `TableInfo.schema`) is a number. */
export function isNumericType(type: string): boolean {
  return NUMERIC_TYPE.test(type)
}

/** A chart request: one numeric column of one series (or of all series), bucketed. */
export type SeriesQuery = { table: string; column: string; bucket: Bucket; series: string | null }

/** A series query checked against the table's schema, ready for a backend to run. */
export type SeriesPlan = {
  table: string
  timeColumn: string
  column: string
  bucket: Bucket
  /** The series-key filter, typed like the key column; null for all series. */
  key: { column: string; value: string | number } | null
}

/** One bucket of a series: avg, min, max and row count. `t` is the bucket start (ISO 8601). */
export type SeriesPoint = { t: string; avg: number | null; min: number | null; max: number | null; n: number }
export type SeriesResult = { rows: SeriesPoint[]; ms: number; query: string }

/**
 * What every lake implementation provides: the CLI (lib/lake/cli.ts) runs the `timelake` binary against a local or
 * object-store warehouse; the WASM reader (lib/lake/wasm.ts) reads a warehouse over HTTPS for hosted deployments.
 */
export interface LakeBackend {
  /** "cli": the timelake binary (full SQL); "wasm": @timelake/client over HTTPS (hosted). */
  readonly kind: "cli" | "wasm"
  /** Where the lake is read from, for display. */
  readonly warehouse: string
  readonly capabilities: { sql: boolean }
  /** Throws LakeNotConfiguredError when this backend cannot run here. */
  ensureConfigured(): Promise<void>
  listTables(): Promise<string[]>
  tableInfo(name: string): Promise<TableInfo>
  latest(name: string): Promise<Row[]>
  sql(query: string): Promise<{ rows: Row[]; ms: number }>
  series(plan: SeriesPlan): Promise<SeriesResult>
}
