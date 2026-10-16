import { DotGrid } from "@/components/dots"
import { type QueryRecord, type Run, SYSTEMS, SYSTEM_COLORS, engineLabel } from "@/lib/benchmarks"

/** Systems in the order the charts list them. */
const ORDER = ["timelake", "parquet", "lance", "iceberg", "s3tables"]

const engineOf = (q: QueryRecord) => `${q.system}+${q.reader}`

/** A system's color; a system read by another engine than its own is drawn at half strength. */
export function engineStyle(run: Run, engine: string): { color: string; alpha: number } {
  const [system = "", reader] = engine.split("+")
  const own = run.header.readers[system]?.[0] === reader
  return { color: SYSTEM_COLORS[system] ?? "var(--chart-2)", alpha: own ? 1 : 0.5 }
}

/** The engines a run queried, each system's own reader first. */
function engines(run: Run): string[] {
  const all = [...new Set(run.queries.map(engineOf))]
  const rank = (e: string) => {
    const [system = "", reader] = e.split("+")
    const own = run.header.readers[system]?.[0] === reader
    return ORDER.indexOf(system) * 2 + (own ? 0 : 1)
  }
  return all.sort((a, b) => rank(a) - rank(b))
}

/** The queries of a run, in the order it ran them. */
function queries(run: Run): string[] {
  return [...new Set(run.queries.map((q) => q.query))]
}

function Swatch({ color, alpha = 1 }: { color: string; alpha?: number }) {
  return <span className="inline-block size-2.5 shrink-0" style={{ background: color, opacity: alpha }} />
}

/** Every engine's color, as a row of chips. */
export function EngineLegend({ run }: { run: Run }) {
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
      {engines(run).map((e) => (
        <span key={e} className="flex items-center gap-2">
          <Swatch {...engineStyle(run, e)} />
          {engineLabel(e)}
        </span>
      ))}
    </div>
  )
}

/** Each system's objects in the bucket after streaming: data files in full color, everything else dimmed. */
export function BucketObjects({ run }: { run: Run }) {
  const rows = ORDER.flatMap((system) => {
    const p = run.phases.find((x) => x.kind === "ingest" && x.system === system && x.status === "ok")
    if (p?.objects == null || p.data_files == null) return []
    return [{ system, objects: p.objects, data: p.data_files, commits: p.commits ?? 0 }]
  })
  return (
    <div className="flex flex-col gap-5 rounded-md border bg-card p-6">
      {rows.map((r) => {
        const color = SYSTEM_COLORS[r.system] ?? "var(--chart-2)"
        return (
          <div key={r.system} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 text-sm">
              <span className={r.system === "timelake" ? "font-medium" : "text-muted-foreground"}>
                {SYSTEMS[r.system] ?? r.system}
              </span>
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {r.data.toLocaleString("en")} data + {(r.objects - r.data).toLocaleString("en")} other ={" "}
                <span className="text-foreground">{r.objects.toLocaleString("en")} objects</span>
              </span>
            </div>
            <DotGrid
              segments={[
                { count: r.data, color },
                { count: r.objects - r.data, color, alpha: 0.3 },
              ]}
              label={`${SYSTEMS[r.system]}: ${r.objects} objects, ${r.data} of them data files`}
            />
          </div>
        )
      })}
      <div className="flex flex-wrap gap-x-5 gap-y-1 border-t pt-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <Swatch color="var(--muted-foreground)" /> Data files
        </span>
        <span className="flex items-center gap-2">
          <Swatch color="var(--muted-foreground)" alpha={0.3} /> Metadata, manifests, and indexes
        </span>
        <span>
          After streaming {rows[0]?.commits.toLocaleString("en")} commits, before any maintenance job. One square per
          object.
        </span>
      </div>
    </div>
  )
}

/**
 * Every query against every engine at one checkpoint: a square per pair in the engine's color, as bright as it is
 * fast (the fastest on a query is full strength). Hover a square for its time.
 */
export function QueryMatrix({ run, checkpoint, title }: { run: Run; checkpoint: string; title: string }) {
  const es = engines(run)
  const qs = queries(run)
  const time = (e: string, query: string) =>
    run.queries.find((q) => engineOf(q) === e && q.query === query && q.checkpoint === checkpoint && q.status === "ok")
      ?.times[0]
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="text-sm font-medium">{title}</div>
      <div
        className="grid items-center gap-x-[3px] gap-y-[3px] overflow-x-auto"
        style={{ gridTemplateColumns: `minmax(10rem, 1fr) repeat(${es.length}, 14px)` }}
      >
        {qs.map((query) => {
          const times = es.map((e) => time(e, query))
          const fastest = Math.min(...times.flatMap((t) => (t === undefined ? [] : [t])))
          return [
            <span key={query} className="truncate pr-2 font-mono text-[11px] text-muted-foreground" title={query}>
              {query}
            </span>,
            ...es.map((e, i) => {
              const t = times[i]
              const { color, alpha } = engineStyle(run, e)
              const ratio = t === undefined ? null : t / fastest
              return (
                <span
                  key={`${query}-${e}`}
                  title={`${engineLabel(e)} · ${query}: ${t === undefined ? "no result" : `${t.toFixed(3)} s${ratio && ratio > 1.05 ? `, ${ratio.toFixed(1)}× the fastest` : ", fastest"}`}`}
                  className={ratio === null ? "size-3.5 border border-dashed" : "size-3.5"}
                  style={
                    ratio === null ? undefined : { background: color, opacity: Math.max(0.1, alpha / ratio ** 0.6) }
                  }
                />
              )
            }),
          ]
        })}
      </div>
    </div>
  )
}

/** Units per square in the per-query lanes. */
const PER_REQUESTS = 25
const PER_MB = 3

/**
 * Each query on each system's own reader: requests (a square per 25) and data read (a square per 3 MB), one lane per
 * system.
 */
export function PerQuery({ run, checkpoint }: { run: Run; checkpoint: string }) {
  const own = ORDER.flatMap((s) => {
    const reader = run.header.readers[s]?.[0]
    return reader ? [`${s}+${reader}`] : []
  })
  const find = (e: string, query: string) =>
    run.queries.find((q) => engineOf(q) === e && q.query === query && q.checkpoint === checkpoint && q.status === "ok")
  return (
    <div className="flex flex-col gap-4 rounded-md border bg-card p-6">
      <div className="grid grid-cols-[minmax(9rem,12rem)_1fr_1fr] gap-x-6 font-mono text-[10.5px] tracking-[0.1em] text-muted-foreground uppercase">
        <span>Query</span>
        <span>Requests · ■ = {PER_REQUESTS}</span>
        <span>Data read · ■ = {PER_MB} MB</span>
      </div>
      {queries(run).map((query) => (
        <div key={query} className="grid grid-cols-[minmax(9rem,12rem)_1fr_1fr] items-start gap-x-6">
          <span className="truncate pt-px font-mono text-[11px] text-muted-foreground" title={query}>
            {query}
          </span>
          {(["requests", "bytes"] as const).map((kind) => (
            <div key={kind} className="flex flex-col gap-[3px]">
              {own.map((e) => {
                const q = find(e, query)
                const n = q?.[kind]?.[0]
                if (n === undefined) return <span key={e} className="h-[2px]" />
                const value = kind === "requests" ? n : n / 1e6
                const per = kind === "requests" ? PER_REQUESTS : PER_MB
                const { color } = engineStyle(run, e)
                return (
                  <div
                    key={e}
                    title={`${engineLabel(e)}: ${kind === "requests" ? `${n.toLocaleString("en")} requests` : `${value.toFixed(1)} MB`}`}
                  >
                    <DotGrid dot={2} gap={1} segments={[{ count: Math.max(1, Math.round(value / per)), color }]} />
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
