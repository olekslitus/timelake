import { Cloud } from "lucide-react"
import type { Metadata } from "next"
import { Suspense } from "react"

import { BenchCharts } from "@/components/bench-charts"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { SUITES, loadIngest, loadPanels, loadS3TablesDelay, loadTsdb, type TsdbRow } from "@/lib/benchmarks"
import { formatNumber, formatSeconds } from "@/lib/format"

export const metadata: Metadata = { title: "Benchmarks" }

const SYSTEMS: Record<string, string> = {
  timelake: "Timelake",
  lance: "Lance",
  iceberg: "Iceberg (PyIceberg)",
  s3tables: "S3 Tables (PyIceberg)",
}

const seconds = (s: number | null) => (s == null ? "—" : formatSeconds(s))

export default function BenchmarksPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-12 px-4 py-12">
      <header className="max-w-3xl space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">Benchmarks</h1>
        <p className="text-muted-foreground">
          Does Timelake beat what a team would otherwise build for time series on object storage? We stream the same IoT
          data into Timelake, naive Iceberg, AWS S3 Tables and Lance, then run the same queries against each.
        </p>
      </header>

      <section className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Workload</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              TSBS IoT: <code className="font-mono">readings</code> and <code className="font-mono">diagnostics</code>,
              11.7M rows each over 3 days, 4,234 trucks, plus a <code className="font-mono">tags</code> table.
            </p>
            <p>
              Ingest: 864 five-minute windows × 2 tables = 1,728 commits of about 13.5k rows (Firehose&apos;s default
              buffer interval). Every system gets identical rows.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Queries and states</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              The 12 TSBS IoT queries plus 5 single-truck queries. Each runs in a fresh process: one first run, then
              repeats.
            </p>
            <p>
              Measured right after ingest (what readers see until a compaction job runs) and after each system&apos;s
              standard maintenance. All row counts matched across engines.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Environment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              One M1 Pro laptop writing to and reading from AWS S3 in us-east-2, about 45 ms away. Times include that
              trip, the same for every system.
            </p>
            <p>
              Naive Iceberg and S3 Tables get the same PyIceberg appends and are read by DuckDB. S3 Tables compacts on
              its own schedule. Lance is read by DuckDB and by DataFusion with Lance&apos;s scanner.
            </p>
          </CardContent>
        </Card>
      </section>

      <Suspense fallback={<div className="h-96 animate-pulse rounded-xl bg-muted" />}>
        <Results />
      </Suspense>

      <section className="space-y-3 text-sm text-muted-foreground">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">Caveats</h2>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>One dataset, from one laptop over the internet. Inside the AWS region every system would be faster.</li>
          <li>
            Right after ingest on S3, five queries failed when S3 reset connections under many parallel reads (four on
            Iceberg, one on DuckDB over Timelake). Charts use the queries every system completed.
          </li>
          <li>
            S3 Tables&apos; compaction is its default (binpack, no sort). Iceberg&apos;s is simulated the same way.
            Lance and Timelake run their own.
          </li>
          <li>
            Timelake keeps replaced files for 1 hour (snapshot retention), so storage on disk exceeds the live table
            size until then.
          </li>
          <li>
            Timelake&apos;s reader reuses a table version loaded in the last second for planning; its own commits are
            always visible.
          </li>
        </ul>
      </section>
    </div>
  )
}

async function Results() {
  const [panels, ingest, tsdb, delay] = await Promise.all([loadPanels(), loadIngest(), loadTsdb(), loadS3TablesDelay()])
  return (
    <>
      <section className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Query time</h2>
          <p className="text-sm text-muted-foreground">
            Timelake&apos;s reader in blue; the multiplier is relative to the fastest engine.
            {delay &&
              ` S3 Tables compacted ${delay[0].toFixed(1)}–${delay[1].toFixed(1)} hours after ingest; until then its readers see the first panel.`}
          </p>
        </div>
        <BenchCharts panels={panels} suites={SUITES} />
      </section>

      <section>
        <Card>
          <CardHeader>
            <CardTitle>Ingest</CardTitle>
            <CardDescription>
              1,728 commits, 23.3M rows. Timelake&apos;s times include its inline compaction and snapshot expiry.
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Storage</TableHead>
                  <TableHead>System</TableHead>
                  <TableHead className="text-right">Wall time</TableHead>
                  <TableHead className="text-right">Commit p50</TableHead>
                  <TableHead className="text-right">Commit p95</TableHead>
                  <TableHead className="text-right">Data files</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ingest.map((r) => (
                  <TableRow key={`${r.storage}-${r.system}`}>
                    <TableCell>
                      <Badge variant="outline">{r.storage === "s3" ? "AWS S3" : "local disk"}</Badge>
                    </TableCell>
                    <TableCell className={r.system === "timelake" ? "font-medium" : undefined}>
                      {SYSTEMS[r.system] ?? r.system}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{r.seconds.toFixed(1)} s</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{Math.round(r.p50)} ms</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{Math.round(r.p95)} ms</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{formatNumber(r.files)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>

      {tsdb && <TsdbSection rows={tsdb} />}
    </>
  )
}

function TsdbSection({ rows }: { rows: TsdbRow[] }) {
  return (
    <section className="space-y-4">
      <div className="max-w-3xl">
        <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <Cloud className="size-5 text-muted-foreground" /> TimescaleDB on Tiger Cloud
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The same data and queries in a disposable Tiger Cloud service (us-east-1, DEV, shared CPU and memory: the
          smallest tier), as a plain hypertable and after converting every chunk to the columnstore. Client times are
          measured from the same laptop and include the network round trip; server time subtracts the median round trip
          of <code className="font-mono">SELECT 1</code>. Timelake rows are its reader on this page&apos;s AWS S3 and
          local runs, for reference: different hardware, so read ratios as indicative. Full write-up in{" "}
          <code className="font-mono">bench/results/TIMESCALE.md</code>.
        </p>
        {!rows.some((r) => r.engine === "tsdb-tiered" && r.completed > 0) && (
          <p className="mt-2 text-sm text-muted-foreground">
            Tiered storage (chunks on S3) is not measured yet: it has to be enabled in the Tiger Console, and it never
            became active on this service.
          </p>
        )}
      </div>
      <div className="grid gap-4">
        {SUITES.filter((s) => rows.some((r) => r.suite === s.id)).map((s) => {
          const rs = rows.filter((r) => r.suite === s.id && (r.engine !== "tsdb-tiered" || r.completed > 0))
          return (
            <Card key={s.id}>
              <CardHeader>
                <CardTitle className="text-base">{s.label}</CardTitle>
                <CardDescription>
                  Geometric means over the {rs[0]?.common ?? 0} queries completed by every variant with data.
                </CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Variant</TableHead>
                      <TableHead className="text-right">Completed</TableHead>
                      <TableHead className="text-right">First run</TableHead>
                      <TableHead className="text-right">First run (server)</TableHead>
                      <TableHead className="text-right">Best repeat (server)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rs.map((r) => (
                      <TableRow key={r.engine} className={r.reference ? "text-muted-foreground" : undefined}>
                        <TableCell className={r.reference ? "font-medium text-foreground" : undefined}>
                          {r.label}
                          {r.reference && (
                            <span className="ml-2 text-xs font-normal text-muted-foreground">reference</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {r.completed}/{r.total}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{seconds(r.firstClient)}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{seconds(r.firstServer)}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{seconds(r.bestServer)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </section>
  )
}
