"use client"

import { LoaderCircle } from "lucide-react"
import { useEffect, useState } from "react"
import { Area, CartesianGrid, ComposedChart, Line, XAxis, YAxis, type TooltipContentProps } from "recharts"

import { ChartTooltipCard } from "@/components/chart-tooltip-card"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { BUCKET_LABELS, DEFAULT_BUCKET, type Bucket } from "@/lib/buckets"
import { formatUtc, formatValue } from "@/lib/format"
import type { SeriesPoint, SeriesResult } from "@/lib/lake/types"

type Result = SeriesResult | { error: string }
type ChartPoint = SeriesPoint & { ts: number; range: [number | null, number | null] }

const config = {
  avg: { label: "Average", color: "var(--chart-1)" },
  range: { label: "Min–max", color: "var(--chart-1)" },
} satisfies ChartConfig

/** Wait this long after the last input change before fetching. */
const DEBOUNCE_MS = 250
/** Most series values offered as suggestions in the input. */
const MAX_SUGGESTIONS = 1000

function PointTooltip({ active, payload }: TooltipContentProps) {
  const point = active ? (payload[0]?.payload as ChartPoint | undefined) : undefined
  if (!point) return null
  return (
    <ChartTooltipCard
      title={`${formatUtc(point.ts, "minutes")} UTC`}
      rows={[
        ["avg", formatValue(point.avg)],
        ["min", formatValue(point.min)],
        ["max", formatValue(point.max)],
        ["rows", formatValue(point.n)],
      ]}
    />
  )
}

export function SeriesExplorer({
  table,
  seriesKey,
  seriesValues,
  columns,
}: {
  table: string
  seriesKey: string | null
  seriesValues: string[]
  columns: string[]
}) {
  const [series, setSeries] = useState(seriesValues[0] ?? "")
  const [column, setColumn] = useState(columns[0] ?? "")
  const [bucket, setBucket] = useState<Bucket>(DEFAULT_BUCKET)
  const query = new URLSearchParams({ table, column, bucket, series }).toString()
  // The latest response and the query it answers; loading = it answers an older query.
  const [response, setResponse] = useState<{ query: string; result: Result } | null>(null)
  const result = response?.result ?? null
  const loading = response?.query !== query

  useEffect(() => {
    if (!column) return
    const ctl = new AbortController()
    const timer = setTimeout(() => {
      fetch(`/api/series?${query}`, { signal: ctl.signal })
        .then((r) => r.json())
        .then((r: Result) => setResponse({ query, result: r }))
        .catch((e: unknown) => {
          if (!ctl.signal.aborted) setResponse({ query, result: { error: String(e) } })
        })
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      ctl.abort()
    }
  }, [query, column])

  const points: ChartPoint[] =
    result && "rows" in result ? result.rows.map((r) => ({ ...r, ts: Date.parse(r.t), range: [r.min, r.max] })) : []
  const short = bucket === "1 day"
  const fmtTick = (ts: number) =>
    new Date(ts).toLocaleString(
      "en-US",
      short
        ? { month: "short", day: "numeric", timeZone: "UTC" }
        : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" },
    )

  if (columns.length === 0) {
    return <p className="py-6 text-sm text-muted-foreground">This table has no numeric columns to chart.</p>
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {column}{" "}
          {seriesKey && series ? (
            <span className="text-muted-foreground">
              · {seriesKey} = {series}
            </span>
          ) : null}
        </CardTitle>
        <CardDescription>Average per {bucket} with the min–max band. Times in UTC.</CardDescription>
        <div className="flex flex-wrap items-center gap-2 pt-2">
          {seriesKey && (
            <>
              <Input
                aria-label={seriesKey}
                list="series-values"
                className="w-44 font-mono"
                value={series}
                onChange={(e) => setSeries(e.target.value)}
                placeholder={seriesKey}
              />
              <datalist id="series-values">
                {seriesValues.slice(0, MAX_SUGGESTIONS).map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            </>
          )}
          <Select value={column} onValueChange={(v) => v && setColumn(v)}>
            <SelectTrigger className="w-48" aria-label="Column">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {columns.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={bucket} onValueChange={(v) => v && setBucket(v as Bucket)}>
            <SelectTrigger className="w-36" aria-label="Bucket">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BUCKET_LABELS.map((b) => (
                <SelectItem key={b} value={b}>
                  {b}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {loading && <LoaderCircle className="size-4 animate-spin text-muted-foreground" />}
          {result && "ms" in result && !loading && (
            <span className="font-mono text-xs text-muted-foreground">
              {result.rows.length} buckets · {Math.round(result.ms)} ms
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {result && "error" in result ? (
          <p className="font-mono text-sm text-destructive">{result.error}</p>
        ) : (
          <ChartContainer config={config} className="aspect-auto h-80 w-full">
            <ComposedChart data={points} margin={{ left: 4, right: 12, top: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="ts"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={fmtTick}
                tickLine={false}
                axisLine={false}
                minTickGap={48}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={56}
                domain={["auto", "auto"]}
                tickFormatter={(v: number) => formatValue(Number(v.toPrecision(3)))}
              />
              <ChartTooltip cursor={{ strokeWidth: 1 }} content={PointTooltip} />
              <Area
                dataKey="range"
                stroke="none"
                fill="var(--color-range)"
                fillOpacity={0.15}
                isAnimationActive={false}
              />
              <Line dataKey="avg" stroke="var(--color-avg)" strokeWidth={2} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ChartContainer>
        )}
        {result && "query" in result && (
          <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
            {result.query}
          </pre>
        )}
      </CardContent>
    </Card>
  )
}
