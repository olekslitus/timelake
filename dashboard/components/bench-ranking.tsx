import type { Ranking } from "@/lib/benchmarks"
import { formatTime, timeUnit } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Results within 5% of the fastest get no multiplier. */
const SAME_AS_FASTEST = 1.05

/**
 * One ranked list: each system's value right after its name, then a bar from zero with the multiplier to the
 * fastest at its end. Lower is better.
 */
export function BenchRanking({ ranking }: { ranking: Ranking }) {
  const fastest = ranking.rows[0]?.value ?? 0
  const slowest = Math.max(...ranking.rows.map((r) => r.value))
  // One unit for the whole list; commit times are recorded in milliseconds.
  const seconds = ranking.rows.map((r) => (ranking.unit === "seconds" ? r.value : r.value / 1000))
  const unit = timeUnit(seconds)
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h4 className="text-sm font-medium">{ranking.title}</h4>
        <span className="text-xs text-muted-foreground">{ranking.note}</span>
      </div>
      <ol className="space-y-1">
        {ranking.rows.map((r, i) => {
          const ratio = fastest > 0 ? r.value / fastest : 1
          return (
            <li
              key={r.key}
              className="grid grid-cols-[1.25rem_minmax(0,13rem)_4.5rem_minmax(0,1fr)] items-center gap-x-2 text-sm"
            >
              <span className="font-mono text-xs text-muted-foreground tabular-nums">{i + 1}</span>
              <span className={cn("truncate", r.timelake ? "font-medium" : "text-muted-foreground")} title={r.label}>
                {r.label}
              </span>
              <span
                className={cn(
                  "text-right font-mono tabular-nums",
                  r.timelake ? "font-medium" : "text-muted-foreground",
                )}
              >
                {formatTime(seconds[i] ?? 0, unit)}
              </span>
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={cn("h-2 shrink-0 rounded-r-sm", r.timelake ? "bg-chart-1" : "bg-chart-2")}
                  style={{ width: `${Math.max(2, (r.value / slowest) * 75)}%` }}
                />
                {ratio > SAME_AS_FASTEST && (
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">{ratio.toFixed(1)}×</span>
                )}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
