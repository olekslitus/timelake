import type { CSSProperties } from "react"

/** A percentile of query times, in seconds: warm (a repeat in the same process) and cold (the first run). */
export type Latency = { label: string; warm: number; cold: number }

/** A fill of 3 px squares on a 4 px grid in `color`: the card's background shows through the gaps. */
const dots = (color: string): CSSProperties => ({
  backgroundColor: color,
  backgroundImage:
    "linear-gradient(to right, transparent 3px, var(--card) 3px), linear-gradient(to bottom, transparent 3px, var(--card) 3px)",
  backgroundSize: "4px 4px",
})

/** A bar `share` (0..1) of the width on a dim track, two squares tall, in whole squares. */
function DotBar({ share, color }: { share: number; color: string }) {
  return (
    <div className="relative h-[7px]">
      <div className="absolute inset-0 opacity-50" style={dots("var(--border)")} />
      <div
        className="absolute inset-y-0 left-0"
        style={{ ...dots(color), width: `max(4px, round(down, ${(share * 100).toFixed(2)}%, 4px))` }}
      />
    </div>
  )
}

const ms = (seconds: number) => `${Math.round(seconds * 1000)} ms`

/** Query-time percentiles as dot bars, warm over cold, each with its time. */
export function LatencyChart({ rows }: { rows: Latency[] }) {
  const longest = Math.max(...rows.flatMap((r) => [r.warm, r.cold]))
  return (
    <div className="flex flex-col gap-3 font-mono text-xs">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[2.5rem_1fr_4rem] items-center gap-x-3">
          <span className="text-muted-foreground">{r.label}</span>
          <div className="flex flex-col gap-1.5">
            <DotBar share={r.warm / longest} color="var(--muted-foreground)" />
            <DotBar share={r.cold / longest} color="var(--primary)" />
          </div>
          <div className="flex flex-col text-right tabular-nums">
            <span className="text-muted-foreground">{ms(r.warm)}</span>
            <span>{ms(r.cold)}</span>
          </div>
        </div>
      ))}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-[7px]" style={dots("var(--muted-foreground)")} /> Warm: a repeat in the same process
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-[7px]" style={dots("var(--primary)")} /> Cold: the first run, in a fresh process
        </span>
      </div>
    </div>
  )
}
