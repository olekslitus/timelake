"use client"

import { CircleAlert, LoaderCircle, Play } from "lucide-react"
import { useState } from "react"

import { RowsTable } from "@/components/rows-table"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import type { Row } from "@/lib/lake/types"

const EXAMPLES: { label: string; sql: string }[] = [
  {
    label: "Latest position per truck",
    sql: "SELECT tags_id, time, latitude, longitude\nFROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY tags_id ORDER BY time DESC) AS rn FROM tsbs.readings)\nWHERE rn = 1\nORDER BY tags_id\nLIMIT 20",
  },
  {
    label: "Hourly fleet velocity",
    sql: "SELECT time_bucket(INTERVAL '1 hour', time) AS hour, avg(velocity) AS avg_velocity, count(*) AS readings\nFROM tsbs.readings\nGROUP BY 1\nORDER BY 1",
  },
  {
    label: "One truck, last hour",
    sql: "SELECT time, velocity, fuel_consumption\nFROM tsbs.readings\nWHERE tags_id = 1 AND time >= TIMESTAMP '2026-01-03 23:00:00'\nORDER BY time",
  },
  {
    label: "Plan with pruning",
    sql: "EXPLAIN SELECT avg(velocity) FROM tsbs.readings WHERE tags_id = 7 AND time >= TIMESTAMP '2026-01-03 00:00:00'",
  },
]

type Result = { rows: Row[]; ms: number } | { error: string }

export function SqlConsole() {
  const [query, setQuery] = useState(EXAMPLES[0].sql)
  const [result, setResult] = useState<Result | null>(null)
  const [running, setRunning] = useState(false)

  async function runQuery() {
    setRunning(true)
    try {
      const r = await fetch("/api/sql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      })
      setResult(await r.json())
    } catch (e) {
      setResult({ error: String(e) })
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((e) => (
              <Button key={e.label} variant="outline" size="sm" onClick={() => setQuery(e.sql)}>
                {e.label}
              </Button>
            ))}
          </div>
          <Textarea
            aria-label="SQL query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                runQuery()
              }
            }}
            spellCheck={false}
            className="min-h-40 font-mono text-sm"
          />
          <div className="flex items-center gap-3">
            <Button onClick={runQuery} disabled={running}>
              {running ? <LoaderCircle className="animate-spin" /> : <Play />}
              Run
            </Button>
            <span className="text-xs text-muted-foreground">⌘ / Ctrl + Enter</span>
          </div>
        </CardContent>
      </Card>

      {result && "error" in result && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription className="font-mono text-xs whitespace-pre-wrap">{result.error}</AlertDescription>
        </Alert>
      )}
      {result && "rows" in result && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-baseline gap-3">
              Result
              <span className="font-mono text-xs font-normal text-muted-foreground">
                {result.rows.length} rows · {Math.round(result.ms)} ms
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <RowsTable rows={result.rows} />
          </CardContent>
        </Card>
      )}
    </>
  )
}
