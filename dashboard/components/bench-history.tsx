"use client"

import { CartesianGrid, Line, LineChart, XAxis, YAxis, type TooltipContentProps } from "recharts"

import { ChartTooltipCard } from "@/components/chart-tooltip-card"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, type ChartConfig } from "@/components/ui/chart"
import { formatTime, timeUnit } from "@/lib/format"

/** One line per system; its color is the system's (lib/benchmarks.ts, SYSTEM_COLORS), whatever else is shown. */
export type HistoryLine = { engine: string; label: string; color: string }
export type HistoryRow = { date: string; commit: string } & Record<string, number | string | undefined>

type Point = { date: string; commit: string; tooltip: [string, string][] }

function HistoryTooltip({ active, payload }: TooltipContentProps) {
  const point = active ? (payload[0]?.payload as Point | undefined) : undefined
  if (!point) return null
  return <ChartTooltipCard title={`${point.date} · ${point.commit}`} rows={point.tooltip} />
}

export function BenchHistory({ lines, rows }: { lines: HistoryLine[]; rows: HistoryRow[] }) {
  // Engine names contain "+", which CSS variable names can't: the chart keys lines by position.
  const keys = lines.map((_, i) => `e${i}`)
  const config = Object.fromEntries(
    lines.map((l, i) => [keys[i], { label: l.label, color: l.color }]),
  ) satisfies ChartConfig
  // One unit for the whole chart: axis and tooltips.
  const unit = timeUnit(
    rows.flatMap((r) => lines.flatMap((l) => (typeof r[l.engine] === "number" ? [r[l.engine] as number] : []))),
  )
  const data = rows.map((r) => ({
    date: r.date,
    commit: r.commit.slice(0, 7),
    ...Object.fromEntries(lines.map((l, i) => [keys[i], r[l.engine]])),
    tooltip: lines.flatMap((l) => {
      const v = r[l.engine]
      return typeof v === "number" ? [[l.label, formatTime(v, unit)] as [string, string]] : []
    }),
  }))

  return (
    <ChartContainer config={config} className="aspect-auto h-72 w-full">
      <LineChart data={data} margin={{ left: 8, right: 16, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis
          scale="log"
          domain={["auto", "auto"]}
          tickFormatter={(v: number) => formatTime(v, unit)}
          tickLine={false}
          axisLine={false}
          width={56}
        />
        <ChartTooltip content={HistoryTooltip} />
        <ChartLegend content={<ChartLegendContent className="flex-wrap" />} />
        {keys.map((k) => (
          <Line
            key={k}
            dataKey={k}
            stroke={`var(--color-${k})`}
            strokeWidth={2}
            dot={{ r: 4, fill: `var(--color-${k})`, strokeWidth: 0 }}
            connectNulls
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ChartContainer>
  )
}
