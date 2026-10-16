import { CircleAlert } from "lucide-react"

import { DotGrid } from "@/components/dots"
import { Race, type Racer } from "@/components/race"
import { type Ranking, type Run, SYSTEM_COLORS, engineLabel, rankings } from "@/lib/benchmarks"
import { formatCompact, formatTime, timeUnit } from "@/lib/format"

/** Columns of squares in the longest bar of a card. */
const SCALE = 40
/** Results within 5% of the fastest get no multiplier. */
const SAME_AS_FASTEST = 1.05

/**
 * One ranking as a card: each system's best engine, its value and a bar of squares in its color, best first, with how
 * many times worse than the best it is and how many of its answers were wrong.
 */
function RankingCard({ ranking }: { ranking: Ranking }) {
  // One row per system: its best engine (rows come best first).
  const rows = ranking.rows.filter((r, i, all) => all.findIndex((x) => x.system === r.system) === i)
  const largest = Math.max(...rows.map((r) => r.value))
  const best = rows[0]?.value ?? 0
  const seconds = rows.map((r) => (ranking.unit === "seconds" ? r.value : r.value / 1000))
  const unit = timeUnit(seconds)
  const show = (i: number) =>
    ranking.unit === "rows/s" ? `${formatCompact(rows[i]?.value ?? 0)}/s` : formatTime(seconds[i] ?? 0, unit)
  // A bar is two rows of squares, as long as its value against the largest.
  const columns = (value: number) => Math.max(1, Math.round((value / largest) * SCALE))
  return (
    <div className="flex flex-col gap-4 rounded-lg border bg-card p-6">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-lg font-normal">{ranking.title}</h3>
        <p className="text-xs text-muted-foreground">{ranking.note}</p>
      </div>
      <ol className="flex flex-col gap-2.5">
        {rows.map((r, i) => {
          const ratio = ranking.higherIsBetter ? best / Math.max(r.value, 1e-9) : best > 0 ? r.value / best : 1
          return (
            <li
              key={r.key}
              className="grid grid-cols-[minmax(0,1fr)_4.5rem] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,12rem)_4.5rem_minmax(0,1fr)]"
            >
              <span
                className={r.timelake ? "truncate text-sm" : "truncate text-sm text-muted-foreground"}
                title={r.label}
              >
                {r.label}
              </span>
              <span
                className={`text-right font-mono text-xs tabular-nums ${r.timelake ? "text-foreground" : "text-muted-foreground"}`}
              >
                {show(i)}
              </span>
              <span className="col-span-2 flex items-center gap-2 sm:col-span-1">
                <DotGrid
                  perRow={columns(r.value)}
                  segments={[{ count: columns(r.value) * 2, color: SYSTEM_COLORS[r.system] ?? "var(--chart-2)" }]}
                  label={`${r.label}: ${show(i)}`}
                />
                {ratio > SAME_AS_FASTEST ? (
                  <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{ratio.toFixed(1)}×</span>
                ) : null}
                {(r.wrong ?? 0) > 0 && (
                  <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                    <CircleAlert className="size-3" aria-hidden />
                    {r.wrong} wrong
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** Each system's own reader for the request race, then the others through DuckDB. */
const RACE_ENGINES = ["timelake+timelake", "lance+duckdb", "iceberg+duckdb", "parquet+duckdb"]

/**
 * The newest weekly run as cards: query times after maintenance and right after ingest, commit times, and the
 * requests one query takes on each system.
 */
export function BenchCards({ run }: { run: Run }) {
  const racers: Racer[] = RACE_ENGINES.flatMap((e) => {
    const q = run.queries.find(
      (x) =>
        `${x.system}+${x.reader}` === e && x.query === "last-loc" && x.checkpoint === "ingested" && x.status === "ok",
    )
    const n = q?.requests?.[0]
    if (!q || n === undefined) return []
    const system = e.split("+")[0] ?? ""
    return [
      {
        label: engineLabel(e),
        value: n,
        dots: n,
        seconds: q.times[0],
        timelake: system === "timelake",
        color: SYSTEM_COLORS[system] ?? "var(--chart-2)",
      },
    ]
  })
  const trucks = run.queries.find((q) => q.query === "last-loc" && q.system === "timelake")?.rows
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {rankings(run).map((r) => (
        <RankingCard key={r.title} ranking={r} />
      ))}
      {racers.length > 1 ? (
        <Race
          title={`Latest position of ${trucks?.toLocaleString("en") ?? "every"} trucks`}
          racers={racers}
          unit="requests"
          dot={2}
          caption="Requests each system makes for one query, right after ingest; each dot is a request, played at the measured pace (sped up)."
        />
      ) : null}
    </div>
  )
}
