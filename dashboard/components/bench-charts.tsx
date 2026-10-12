"use client"

import { Bar, BarChart, Cell, LabelList, XAxis, YAxis } from "recharts"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

type Bar = { engine: string; label: string; timelake: boolean; first: number; best: number }
type Panel = { suite: string; state: string; bars: Bar[]; queries: number }

const config = {
  first: { label: "First run", color: "var(--chart-2)" },
} satisfies ChartConfig

function fmtSeconds(s: number) {
  return s < 0.1 ? `${(s * 1000).toFixed(0)} ms` : `${s.toFixed(2)} s`
}

function PanelChart({ panel }: { panel: Panel }) {
  const fastest = Math.min(...panel.bars.map((b) => b.first))
  const data = [...panel.bars]
    .sort((a, b) => a.first - b.first)
    .map((b) => ({ ...b, tag: `${fmtSeconds(b.first)}${b.first > fastest * 1.05 ? ` · ${(b.first / fastest).toFixed(1)}×` : ""}` }))
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{panel.state}</CardTitle>
        <CardDescription>First run, geometric mean over {panel.queries} queries. Lower is better.</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={config} className="aspect-auto h-56 w-full">
          <BarChart data={data} layout="vertical" margin={{ left: 0, right: 120 }} barCategoryGap={6}>
            <XAxis type="number" hide domain={[0, "dataMax"]} />
            <YAxis type="category" dataKey="label" width={170} tickLine={false} axisLine={false} />
            <ChartTooltip
              cursor={false}
              content={({ active, payload }) => {
                const b = active && (payload?.[0]?.payload as Bar | undefined)
                if (!b) return null
                return (
                  <div className="rounded-lg border bg-background px-3 py-2 text-xs shadow-sm">
                    <div className="mb-1 font-medium">{b.label}</div>
                    <div className="grid grid-cols-[auto_auto] gap-x-4 font-mono tabular-nums">
                      <span className="text-muted-foreground">first run</span>
                      <span className="text-right">{fmtSeconds(b.first)}</span>
                      <span className="text-muted-foreground">best repeat</span>
                      <span className="text-right">{fmtSeconds(b.best)}</span>
                    </div>
                  </div>
                )
              }}
            />
            <Bar dataKey="first" radius={[0, 4, 4, 0]} isAnimationActive={false}>
              {data.map((d) => (
                <Cell key={d.engine} fill={d.timelake ? "var(--chart-1)" : "var(--chart-2)"} />
              ))}
              <LabelList dataKey="tag" position="right" className="fill-foreground font-mono" fontSize={11} />
            </Bar>
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}

export function BenchCharts({ panels, suites }: { panels: Panel[]; suites: { id: string; label: string }[] }) {
  const available = suites.filter((s) => panels.some((p) => p.suite === s.id))
  if (available.length === 0) {
    return <p className="text-sm text-muted-foreground">No v0 results found. Run bench/v0/run_all.sh.</p>
  }
  return (
    <Tabs defaultValue={available[0].id}>
      <TabsList>
        {available.map((s) => (
          <TabsTrigger key={s.id} value={s.id}>
            {s.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {available.map((s) => (
        <TabsContent key={s.id} value={s.id} className="grid gap-4 pt-2 xl:grid-cols-2">
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
