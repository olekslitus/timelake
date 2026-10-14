import "server-only"
import { Lake, type TableInfo as ClientInfo } from "@timelake/client"
import { connection } from "next/server"

import { BUCKETS } from "@/lib/buckets"

import { LakeInputError, LakeNotConfiguredError } from "./errors"
import type { LakeBackend, Row, SeriesQuery, SeriesResult, TableInfo } from "./types"

/**
 * Reads a warehouse served over HTTPS (Vercel Blob, a public bucket, a CDN) with the WASM reader
 * in @timelake/client. No binary and no server-side engine: this is the hosted mode.
 */
const URL_ = process.env.TIMELAKE_URL ?? ""

let lake: Lake | null = null
function getLake(): Lake {
  if (!URL_) throw new LakeNotConfiguredError("TIMELAKE_URL is not set.")
  lake ??= new Lake(URL_, { cacheMs: 10_000 })
  return lake
}

// Iceberg type names → the Arrow-style names the explorer UI expects (same as the CLI's output).
const ARROW: Record<string, string> = {
  boolean: "Boolean",
  int: "Int32",
  long: "Int64",
  float: "Float32",
  double: "Float64",
  string: "Utf8",
  date: "Date32",
  timestamp: "Timestamp(µs)",
  timestamptz: 'Timestamp(µs, "+00:00")',
}

function partitionLabel(chunk: string | null, v: number | null): string {
  if (v === null || chunk === null) return "-"
  const iso = (ms: number) => new Date(ms).toISOString()
  if (chunk === "hour")
    return iso(v * 3_600_000)
      .slice(0, 13)
      .replace("T", "-")
  if (chunk === "month") return `${1970 + Math.floor(v / 12)}-${String((v % 12) + 1).padStart(2, "0")}`
  return iso(v * 86_400_000).slice(0, 10)
}

function toInfo(c: ClientInfo): TableInfo {
  const parts = new Map<number | null, { files: number; rows: number; bytes: number }>()
  for (const f of c.files) {
    const p = parts.get(f.partition) ?? { files: 0, rows: 0, bytes: 0 }
    p.files++
    p.rows += f.records
    p.bytes += f.size
    parts.set(f.partition, p)
  }
  const num = (s: Record<string, string>, k: string) => Number(s[k] ?? 0)
  return {
    name: c.name,
    version: c.version,
    location: c.location,
    format_version: `V${c.formatVersion}`,
    time_column: c.timeColumn,
    series_key: c.seriesKey,
    chunk: c.chunk,
    dedup: c.dedup,
    retention_days: c.properties["timelake.retention"] ? Number.parseInt(c.properties["timelake.retention"]) : null,
    schema: c.schema.map((f) => ({ name: f.name, type: ARROW[f.type] ?? f.type, nullable: !f.required })),
    rows: c.files.reduce((s, f) => s + f.records, 0),
    files: c.files.length,
    bytes: c.files.reduce((s, f) => s + f.size, 0),
    manifests: c.manifests,
    snapshot_count: c.snapshotCount,
    last_commit_ms: c.currentSnapshot?.timestampMs ?? null,
    last_value_index: c.lastValueIndex,
    partitions: [...parts.entries()]
      .sort((a, b) => (b[0] ?? 0) - (a[0] ?? 0))
      .map(([p, v]) => ({ partition: partitionLabel(c.chunk, p), ...v })),
    snapshots: c.snapshots.map((s) => ({
      id: s.id,
      timestamp_ms: s.timestampMs,
      operation: s.operation,
      added_records: num(s.summary, "added-records"),
      deleted_records: num(s.summary, "deleted-records"),
      added_files: num(s.summary, "added-data-files"),
      deleted_files: num(s.summary, "deleted-data-files"),
      total_records: num(s.summary, "total-records"),
    })),
  }
}

const EVERY: Record<string, "1m" | "10m" | "1h" | "1d"> = {
  "1 minute": "1m",
  "10 minutes": "10m",
  "1 hour": "1h",
  "1 day": "1d",
}

async function series({ table, column, bucket, series }: SeriesQuery): Promise<SeriesResult> {
  await connection()
  const t = getLake().table(table)
  const info = await t.info()
  const col = info.schema.find((f) => f.name === column && ["int", "long", "float", "double"].includes(f.type))
  if (!info.timeColumn || !col) throw new LakeInputError("Pick a numeric column of a time-series table.")
  if (!(BUCKETS as readonly string[]).includes(bucket)) throw new LakeInputError("Unknown bucket.")
  const key = info.seriesKey[0]
  let value: string | number | undefined
  if (key && series !== null && series !== "") {
    const keyType = info.schema.find((f) => f.name === key)?.type ?? ""
    if (["int", "long"].includes(keyType)) {
      if (!Number.isFinite(Number(series))) throw new LakeInputError(`${key} must be a number.`)
      value = Number(series)
    } else {
      value = series
    }
  }
  const every = EVERY[bucket]
  const agg = { [column]: ["avg", "min", "max"], "*": ["count"] } as const
  const rows = await t.bucket({ series: value, every, agg })
  const pick = (r: Record<string, unknown>, k: string) => (r[k] ?? null) as number | null
  const q = `await lake.table(${JSON.stringify(table)}).bucket({\n  ${value !== undefined ? `series: ${JSON.stringify(value)}, ` : ""}every: "${every}",\n  agg: { ${column}: ["avg", "min", "max"], "*": ["count"] },\n})\n// ${t.lastStats.requests} HTTP requests, ${(t.lastStats.bytes / 1024).toFixed(0)} KiB from ${t.lastStats.files} file(s)`
  return {
    rows: rows.map((r) => {
      const o = r as unknown as Record<string, unknown>
      return {
        t: (r.bucket as Date).toISOString(),
        avg: pick(o, `${column}_avg`),
        min: pick(o, `${column}_min`),
        max: pick(o, `${column}_max`),
        n: Number(o.count ?? 0),
      }
    }),
    ms: t.lastStats.ms,
    query: q,
  }
}

export const wasmBackend: LakeBackend = {
  kind: "wasm",
  warehouse: URL_,
  capabilities: { sql: false },
  async ensureConfigured() {
    await connection()
    getLake()
  },
  async listTables() {
    await connection()
    return getLake().tables()
  },
  async tableInfo(name) {
    await connection()
    return toInfo(await getLake().table(name).info())
  },
  async latest(name) {
    await connection()
    return (await getLake().table(name).latest()) as Row[]
  },
  async sql() {
    throw new LakeInputError(
      "SQL needs the Timelake engine (CLI). The hosted explorer reads tables with the WASM client.",
    )
  },
  series,
}
