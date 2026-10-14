/**
 * @timelake/client: read Timelake tables over HTTPS from the browser, Node, or serverless
 * functions. A WebAssembly build of Timelake's reader parses Iceberg metadata, prunes files and
 * row groups, and decodes Parquet; this package fetches only the byte ranges it asks for.
 *
 * ```ts
 * import { z } from "zod"
 * import { Lake } from "@timelake/client"
 *
 * const Reading = z.object({ time: z.coerce.date(), tags_id: z.number().int(), velocity: z.number().nullable() })
 * const lake = new Lake("https://<store>.public.blob.vercel-storage.com/demo")
 * const readings = lake.table("tsbs.readings", Reading)
 * await readings.latest({ series: [1, 2, 3] })                  // newest row per truck
 * await readings.range({ series: 7, from: "2026-01-03T12:00:00Z", to: "2026-01-03T13:00:00Z" })
 * await readings.bucket({ series: 7, every: "1h", agg: { velocity: ["avg", "max"] } })
 * ```
 */

import type { z } from "zod"

import { wasmBase64 } from "./wasm/inline.js"
import { ParquetFile, Query, Table as WasmTable, initSync, version as wasmVersion } from "./wasm/timelake_wasm.js"

// --- WASM init -------------------------------------------------------------------------------------

let ready = false
function ensureWasm() {
  if (ready) return
  const bin = atob(wasmBase64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  initSync({ module: bytes })
  ready = true
}

/** Version of the embedded WASM reader. */
export function readerVersion(): string {
  ensureWasm()
  return wasmVersion()
}

// --- types -----------------------------------------------------------------------------------------

export type Row = Record<string, unknown>
export type Scalar = string | number
/** Series filter: one value or a list for the (first) series key, or `{ column: value(s) }`. */
export type SeriesFilter = Scalar | Scalar[] | Record<string, Scalar | Scalar[]>
/** A point in time: Date, ISO string, or epoch milliseconds. */
export type TimeInput = Date | string | number
/** A duration: "30s", "10m", "1h", "1d", "1w", or milliseconds. */
export type DurationInput = `${number}${"ms" | "s" | "m" | "h" | "d" | "w"}` | number
export type AggOp = "count" | "sum" | "avg" | "min" | "max" | "first" | "last"
export type AggMap = { readonly [column: string]: readonly AggOp[] }

/** Output column names of an aggregation map: `velocity_avg`, …; `"*": ["count"]` is `count`. */
export type AggKeys<A extends AggMap> = {
  [C in keyof A & string]: C extends "*" ? "count" : `${C}_${A[C][number]}`
}[keyof A & string]

export type BucketRow<A extends AggMap, By extends string = never> = { bucket: Date } & {
  [K in AggKeys<A>]: number | null
} & {
  [K in By]: Scalar | null
}

export interface LakeOptions {
  /** fetch implementation (defaults to the global fetch). */
  fetch?: typeof fetch
  /** Maximum concurrent HTTP requests per query. Default 16. */
  concurrency?: number
  /** How long a loaded table version is reused, in ms. Default 5000. */
  cacheMs?: number
  /** Rewrite object URLs before fetching (e.g. when a warehouse was copied to a new host). */
  rewriteUrl?: (url: string) => string
}

export interface TableInfo {
  name: string
  location: string
  formatVersion: number
  schema: { id: number; name: string; type: string; required: boolean }[]
  timeColumn: string | null
  seriesKey: string[]
  chunk: string | null
  dedup: boolean
  properties: Record<string, string>
  currentSnapshot: { id: string; timestampMs: number; operation: string; summary: Record<string, string> } | null
  lastValueIndex: string | null
  snapshotCount: number
  /** Newest first, at most 50. */
  snapshots: { id: string; timestampMs: number; operation: string; summary: Record<string, string> }[]
  lastUpdatedMs: number
  /** Committed version (`vN.metadata.json`). */
  version: number
  /** Number of manifests in the current snapshot. */
  manifests: number
  files: { path: string; size: number; records: number; partition: number | null }[]
}

export interface RangeOptions {
  series?: SeriesFilter
  from?: TimeInput
  to?: TimeInput
  columns?: string[]
  limit?: number
  order?: "asc" | "desc"
}

export interface BucketOptions<A extends AggMap, By extends string> {
  series?: SeriesFilter
  from?: TimeInput
  to?: TimeInput
  every: DurationInput
  agg: A
  /** Also group by these columns (e.g. the series key) instead of merging series. */
  by?: readonly By[]
}

/** Request statistics of the last query on a table handle. */
export interface QueryStats {
  requests: number
  bytes: number
  files: number
  ms: number
}

// --- helpers ---------------------------------------------------------------------------------------

function micros(t: TimeInput): number {
  const ms = t instanceof Date ? t.getTime() : typeof t === "number" ? t : Date.parse(t)
  if (!Number.isFinite(ms)) throw new Error(`invalid time: ${String(t)}`)
  return Math.round(ms * 1000)
}

const UNIT_MS = { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 } as const

function durationMicros(d: DurationInput): number {
  if (typeof d === "number") return Math.round(d * 1000)
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(d)
  if (!m) throw new Error(`invalid duration: ${d} (use e.g. 10m, 1h, 1d)`)
  return Math.round(Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS] * 1000)
}

class Limiter {
  private active = 0
  private queue: (() => void)[] = []
  constructor(private max: number) {}
  async run<T>(f: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r))
    this.active++
    try {
      return await f()
    } finally {
      this.active--
      this.queue.shift()?.()
    }
  }
}

// --- Lake ------------------------------------------------------------------------------------------

/** A Timelake warehouse served over HTTP(S): Vercel Blob, S3/R2/GCS public URLs, a CDN, … */
export class Lake {
  readonly url: string
  readonly options: Required<Omit<LakeOptions, "rewriteUrl">> & Pick<LakeOptions, "rewriteUrl">

  constructor(url: string, options: LakeOptions = {}) {
    this.url = url.replace(/\/+$/, "")
    this.options = {
      fetch: options.fetch ?? ((...a) => globalThis.fetch(...a)),
      concurrency: options.concurrency ?? 16,
      cacheMs: options.cacheMs ?? 5000,
      rewriteUrl: options.rewriteUrl,
    }
  }

  /** Table names (`namespace.table`) from the warehouse's `timelake-tables.json`. */
  async tables(): Promise<string[]> {
    const r = await this.fetchOk(`${this.url}/timelake-tables.json`)
    return (await r.json()) as string[]
  }

  /**
   * A table handle. Pass a Zod schema to validate and type rows (use `z.coerce.date()` for time
   * columns; values arrive as ISO strings). Without one, rows are `Record<string, unknown>`.
   */
  table<S extends z.ZodType = z.ZodType<Row>>(name: string, schema?: S): TableHandle<z.output<S>> {
    return new TableHandle(this, name, schema)
  }

  /** @internal */
  async fetchOk(url: string, init?: RequestInit): Promise<Response> {
    const target = this.options.rewriteUrl ? this.options.rewriteUrl(url) : url
    const r = await this.options.fetch(target, init)
    if (!r.ok) throw new Error(`GET ${target}: HTTP ${r.status}`)
    return r
  }
}

type Loaded = {
  wasm: WasmTable
  info: Omit<TableInfo, "files" | "name" | "version" | "manifests">
  files: TableInfo["files"]
  version: number
  manifests: number
  at: number
}

export class TableHandle<T = Row> {
  private loaded: Promise<Loaded> | null = null
  private loadedAt = 0
  /** Statistics of the last query. */
  lastStats: QueryStats = { requests: 0, bytes: 0, files: 0, ms: 0 }

  constructor(
    readonly lake: Lake,
    readonly name: string,
    private schema?: z.ZodType,
  ) {
    if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?$/.test(name)) throw new Error(`invalid table name: ${name}`)
  }

  private get location(): string {
    const [ns, t] = this.name.includes(".") ? this.name.split(".") : ["default", this.name]
    return `${this.lake.url}/${ns}/${t}`
  }

  /** Loads (or reuses) the current table version: metadata, manifest list and manifests. */
  private load(force = false): Promise<Loaded> {
    if (!force && this.loaded && Date.now() - this.loadedAt < this.lake.options.cacheMs) return this.loaded
    this.loadedAt = Date.now()
    this.loaded = (async () => {
      ensureWasm()
      const hint = (await (await this.lake.fetchOk(`${this.location}/metadata/version-hint.text`)).text()).trim()
      const version = Number(hint)
      if (!Number.isInteger(version)) throw new Error(`${this.name}: bad version hint ${JSON.stringify(hint)}`)
      // The hint is updated after each commit; it may lag by one version.
      const [meta, next] = await Promise.all([
        this.lake.fetchOk(`${this.location}/metadata/v${version}.metadata.json`).then((r) => r.text()),
        this.lake.options.fetch(this.rewrite(`${this.location}/metadata/v${version + 1}.metadata.json`), {
          method: "HEAD",
        }),
      ])
      const metaJson = next.ok
        ? await (await this.lake.fetchOk(`${this.location}/metadata/v${version + 1}.metadata.json`)).text()
        : meta
      const wasm = new WasmTable(metaJson)
      const list = wasm.manifestList
      let manifests: string[] = []
      if (list) {
        const listBytes = await this.bytes(list)
        manifests = wasm.addManifestList(listBytes)
        const lim = new Limiter(this.lake.options.concurrency)
        const bodies = await Promise.all(manifests.map((m) => lim.run(() => this.bytes(m))))
        for (const b of bodies) wasm.addManifest(b)
      }
      return {
        wasm,
        info: wasm.info() as Loaded["info"],
        files: wasm.files() as TableInfo["files"],
        version: next.ok ? version + 1 : version,
        manifests: manifests.length,
        at: Date.now(),
      }
    })()
    this.loaded.catch(() => {
      this.loaded = null
    })
    return this.loaded
  }

  /** Drops the cached table version; the next call loads the latest commit. */
  refresh(): this {
    this.loaded = null
    return this
  }

  private rewrite(url: string) {
    return this.lake.options.rewriteUrl ? this.lake.options.rewriteUrl(url) : url
  }

  private async bytes(url: string, range?: [number, number], stats?: QueryStats): Promise<Uint8Array> {
    const headers = range ? { Range: `bytes=${range[0]}-${range[1] - 1}` } : undefined
    const r = await this.lake.fetchOk(url, headers ? { headers } : undefined)
    let b = new Uint8Array(await r.arrayBuffer())
    // Servers that ignore Range answer 200 with the whole object.
    if (range && r.status === 200 && b.length > range[1] - range[0]) b = b.slice(range[0], range[1])
    if (stats) {
      stats.requests++
      stats.bytes += b.length
    }
    return b
  }

  /** Contract, schema, snapshot and live files of the current version. */
  async info(): Promise<TableInfo> {
    const l = await this.load()
    return { name: this.name, ...l.info, version: l.version, manifests: l.manifests, files: l.files }
  }

  private seriesSpec(info: Loaded["info"], series?: SeriesFilter): Record<string, Scalar[]> {
    if (series === undefined) return {}
    if (typeof series === "object" && !Array.isArray(series)) {
      return Object.fromEntries(Object.entries(series).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]))
    }
    const key = info.seriesKey[0]
    if (!key) throw new Error(`${this.name} has no series key; pass { column: value } instead`)
    return { [key]: Array.isArray(series) ? series : [series] }
  }

  /** Runs a query spec over the given files. */
  private async run(files: { path: string; size: number }[], spec: object, stats: QueryStats): Promise<unknown[]> {
    // The limit applies to single requests, never to a file's whole read: a file waiting for
    // its byte ranges must not hold a slot those ranges need.
    const lim = new Limiter(this.lake.options.concurrency)
    const get = (path: string, range: [number, number]) => lim.run(() => this.bytes(path, range, stats))
    const query = new Query(spec)
    try {
      // Read files concurrently, decode in order (decoding is synchronous WASM work).
      const opened = await Promise.all(
        files.map(async (f) => {
          const tailLen = Math.min(f.size, 64 * 1024)
          let tail = await get(f.path, [f.size - tailLen, f.size])
          const need = ParquetFile.footerLength(tail)
          if (need > tail.length) tail = await get(f.path, [f.size - need, f.size])
          const pf = new ParquetFile(f.size, tail)
          const ranges = pf.plan(spec) as [number, number][]
          const chunks = await Promise.all(ranges.map((r) => get(f.path, r)))
          ranges.forEach((r, i) => pf.addRange(r[0], chunks[i]))
          return pf
        }),
      )
      for (const pf of opened) {
        try {
          query.push(pf)
        } finally {
          pf.free()
        }
      }
      stats.files = files.length
      return JSON.parse(query.finish()) as unknown[]
    } finally {
      query.free()
    }
  }

  private validate(rows: unknown[], columns?: string[]): T[] {
    if (!this.schema) return rows as T[]
    let schema = this.schema
    // A projection returns some columns only: validate against the matching part of the schema.
    const pick = (schema as unknown as { pick?: (m: Record<string, true>) => z.ZodType }).pick
    if (columns?.length && typeof pick === "function") {
      schema = pick.call(schema, Object.fromEntries(columns.map((c) => [c, true as const])))
    }
    return rows.map((r) => schema.parse(r) as T)
  }

  /**
   * The newest row of each series, from the table's last-value index (one small file).
   * Filter with `series`; falls back to scanning when the table has no index.
   */
  async latest<C extends keyof T & string>(opts: { series?: SeriesFilter; columns: C[] }): Promise<Pick<T, C>[]>
  async latest(opts?: { series?: SeriesFilter; columns?: string[] }): Promise<T[]>
  async latest(opts: { series?: SeriesFilter; columns?: string[] } = {}): Promise<T[]> {
    const t0 = performance.now()
    const l = await this.load()
    const stats: QueryStats = { requests: 0, bytes: 0, files: 0, ms: 0 }
    const spec = {
      timeColumn: l.info.timeColumn,
      series: this.seriesSpec(l.info, opts.series),
      columns: opts.columns ?? [],
    }
    if (!l.info.lastValueIndex) throw new Error(`${this.name} has no last-value index`)
    // The index is one small Parquet file: fetch it whole and decode it in place.
    const whole = await this.bytes(l.info.lastValueIndex, undefined, stats)
    const query = new Query(spec)
    let rows: unknown[]
    try {
      const pf = new ParquetFile(whole.length, whole)
      try {
        pf.plan(spec)
        pf.addRange(0, whole)
        query.push(pf)
      } finally {
        pf.free()
      }
      rows = JSON.parse(query.finish()) as unknown[]
    } finally {
      query.free()
    }
    stats.files = 1
    this.lastStats = { ...stats, ms: performance.now() - t0 }
    return this.validate(rows, opts.columns)
  }

  /** Rows of the selected series in `[from, to)`, ordered by time. */
  async range<C extends keyof T & string>(opts: RangeOptions & { columns: C[] }): Promise<Pick<T, C>[]>
  async range(opts?: RangeOptions): Promise<T[]>
  async range(opts: RangeOptions = {}): Promise<T[]> {
    const t0 = performance.now()
    const l = await this.load()
    const stats: QueryStats = { requests: 0, bytes: 0, files: 0, ms: 0 }
    const spec = {
      timeColumn: l.info.timeColumn,
      series: this.seriesSpec(l.info, opts.series),
      from: opts.from !== undefined ? micros(opts.from) : undefined,
      to: opts.to !== undefined ? micros(opts.to) : undefined,
      columns: opts.columns ?? [],
      limit: opts.limit,
      descending: opts.order === "desc",
    }
    const files = l.wasm.planFiles(spec) as { path: string; size: number }[]
    const rows = await this.run(files, spec, stats)
    this.lastStats = { ...stats, ms: performance.now() - t0 }
    return this.validate(rows, opts.columns)
  }

  /** Time-bucketed aggregates, e.g. `{ every: "1h", agg: { velocity: ["avg", "max"] } }`. */
  async bucket<A extends AggMap, By extends string = never>(opts: BucketOptions<A, By>): Promise<BucketRow<A, By>[]> {
    const t0 = performance.now()
    const l = await this.load()
    if (!l.info.timeColumn) throw new Error(`${this.name} has no time column`)
    const stats: QueryStats = { requests: 0, bytes: 0, files: 0, ms: 0 }
    const aggs = Object.entries(opts.agg).flatMap(([column, ops]) => ops.map((op) => ({ column, op })))
    const spec = {
      timeColumn: l.info.timeColumn,
      series: this.seriesSpec(l.info, opts.series),
      from: opts.from !== undefined ? micros(opts.from) : undefined,
      to: opts.to !== undefined ? micros(opts.to) : undefined,
      bucket: { every: durationMicros(opts.every), by: [...(opts.by ?? [])], aggs },
    }
    const files = l.wasm.planFiles(spec) as { path: string; size: number }[]
    const rows = (await this.run(files, spec, stats)) as (Record<string, unknown> & { bucket: string })[]
    this.lastStats = { ...stats, ms: performance.now() - t0 }
    return rows.map((r) => ({ ...r, bucket: new Date(r.bucket) })) as unknown as BucketRow<A, By>[]
  }

  /** TypeScript source of a Zod schema for this table's rows (paste it into your code). */
  async zodSource(exportName?: string): Promise<string> {
    return zodSource(await this.info(), exportName)
  }
}

// --- Zod helpers -------------------------------------------------------------------------------------

function zodType(icebergType: string): string {
  if (icebergType.startsWith("timestamp")) return "z.coerce.date()"
  switch (icebergType) {
    case "int":
    case "long":
      return "z.number().int()"
    case "float":
    case "double":
      return "z.number()"
    case "boolean":
      return "z.boolean()"
    default:
      return "z.string()"
  }
}

/** Zod schema source for a table's rows (time columns coerce ISO strings to `Date`). */
export function zodSource(info: Pick<TableInfo, "name" | "schema">, exportName?: string): string {
  const name =
    exportName ??
    info.name
      .split(".")
      .pop()!
      .replace(/(^|[_-])(\w)/g, (_, __, c: string) => c.toUpperCase())
      .replace(/s$/, "")
  const fields = info.schema.map(
    (f) =>
      `  ${/^[A-Za-z_]\w*$/.test(f.name) ? f.name : JSON.stringify(f.name)}: ${zodType(f.type)}${f.required ? "" : ".nullable()"},`,
  )
  return `export const ${name} = z.object({\n${fields.join("\n")}\n})\nexport type ${name} = z.infer<typeof ${name}>\n`
}
