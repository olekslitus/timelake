"use client"

import { ChevronDown, CircleAlert } from "lucide-react"
import { Bar, BarChart, Cell, LabelList, XAxis, YAxis, type TooltipContentProps } from "recharts"

import { ChartTooltipCard } from "@/components/chart-tooltip-card"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { BenchBar, BenchPanel } from "@/lib/benchmarks"
import { formatNumber, formatTime, timeUnit, type TimeUnit } from "@/lib/format"

const config = { first: { label: "First run", color: "var(--chart-2)" } } satisfies ChartConfig

/** Bars within 5% of the fastest get no "× slower" tag. */
const SAME_AS_FASTEST = 1.05

function BarTooltip({ active, payload }: TooltipContentProps) {
  const bar = active ? (payload[0]?.payload as (BenchBar & { unit: TimeUnit }) | undefined) : undefined
  if (!bar) return null
  const rows: [string, string][] = [
    ["first run", formatTime(bar.first, bar.unit)],
    ["best repeat", formatTime(bar.best, bar.unit)],
  ]
  if (bar.requests != null) rows.push(["requests", formatNumber(Math.round(bar.requests))])
  return <ChartTooltipCard title={bar.label} rows={rows} />
}

function PanelChart({ panel }: { panel: BenchPanel }) {
  const fastest = Math.min(...panel.bars.map((b) => b.first))
  // One unit for the chart, so values compare at a glance.
  const unit = timeUnit(panel.bars.flatMap((b) => [b.first, b.best]))
  const data = [...panel.bars]
    .sort((a, b) => a.first - b.first)
    .map((b) => ({
      ...b,
      unit,
      tag: `${formatTime(b.first, unit)}${b.first > fastest * SAME_AS_FASTEST ? ` · ${(b.first / fastest).toFixed(1)}×` : ""}`,
    }))
  const engines = panel.bars.map((b) => b.engine)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{panel.state}</CardTitle>
        <CardDescription>First run, geometric mean over {panel.queries} queries. Lower is better.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ChartContainer config={config} className="aspect-auto h-56 w-full">
          <BarChart data={data} layout="vertical" margin={{ left: 0, right: 120 }} barCategoryGap={6}>
            <XAxis type="number" hide domain={[0, "dataMax"]} />
            <YAxis type="category" dataKey="label" width={150} tickLine={false} axisLine={false} />
            <ChartTooltip cursor={false} content={BarTooltip} />
            <Bar dataKey="first" radius={[0, 4, 4, 0]} isAnimationActive={false}>
              {data.map((d) => (
                <Cell key={d.engine} fill={d.timelake ? "var(--chart-1)" : "var(--chart-2)"} />
              ))}
              <LabelList dataKey="tag" position="right" className="fill-foreground font-mono" fontSize={11} />
            </Bar>
          </BarChart>
        </ChartContainer>
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronDown className="size-3 transition-transform group-data-[panel-open]:rotate-180" />
            Per query, first run
          </CollapsibleTrigger>
          <CollapsibleContent className="overflow-x-auto pt-2">
            <Table className="text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead>Query</TableHead>
                  {panel.bars.map((b) => (
                    <TableHead key={b.engine} className="text-right whitespace-normal">
                      {b.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {panel.perQuery.map((q) => {
                  // One unit per query: its row compares the engines.
                  const rowUnit = timeUnit(Object.values(q.times).filter((t) => t != null))
                  return (
                    <TableRow key={q.query}>
                      <TableCell className="font-mono">{q.query}</TableCell>
                      {engines.map((e) => {
                        const time = q.times[e]
                        const wrong = q.wrong.includes(e)
                        return (
                          <TableCell key={e} className="text-right font-mono tabular-nums">
                            {time == null ? "—" : formatTime(time, rowUnit)}
                            {wrong && (
                              <span className="ml-1 inline-flex items-center gap-0.5 text-muted-foreground">
                                <CircleAlert className="size-3" aria-hidden />
                                wrong
                              </span>
                            )}
                          </TableCell>
                        )
                      })}
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  )
}

export function BenchCharts({
  panels,
  suites,
}: {
  panels: BenchPanel[]
  suites: readonly { id: string; label: string }[]
}) {
  const available = suites.filter((s) => panels.some((p) => p.suite === s.id))
  const [first] = available
  if (!first) {
    return <p className="text-sm text-muted-foreground">No v0 results found in bench/results.</p>
  }
  return (
    <Tabs defaultValue={first.id}>
      <TabsList>
        {available.map((s) => (
          <TabsTrigger key={s.id} value={s.id}>
            {s.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {available.map((s) => (
        <TabsContent key={s.id} value={s.id} className="grid gap-4 pt-2 lg:grid-cols-2">
          {panels
            .filter((p) => p.suite === s.id)
            .map((p) => (
              <PanelChart key={p.state} panel={p} />
            ))}
        </TabsContent>
      ))}
    </Tabs>
  )
}
