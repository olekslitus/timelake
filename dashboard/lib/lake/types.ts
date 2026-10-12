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

/** One series of a time-series table, bucketed: avg, min, max and count per bucket. */
export type SeriesQuery = { table: string; column: string; bucket: string; series: string | null }
export type SeriesPoint = { t: string; avg: number | null; min: number | null; max: number | null; n: number }
export type SeriesResult = { rows: SeriesPoint[]; ms: number; query: string }

/**
 * What every lake implementation provides. The CLI implementation (lib/lake/cli.ts) runs the
 * `timelake` binary against a local or object-store warehouse; a WASM implementation can sit next
 * to it for hosted deployments.
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
  series(q: SeriesQuery): Promise<SeriesResult>
}
