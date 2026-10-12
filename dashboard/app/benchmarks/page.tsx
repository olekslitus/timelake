import { Suspense } from "react"

import { BenchCharts } from "@/components/bench-charts"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { SUITES, loadIngest, loadPanels } from "@/lib/benchmarks"
import { formatNumber } from "@/lib/format"

export default function BenchmarksPage() {
  return (
    <>
      <PageHeader
        title="Benchmarks"
        description="v0: TSBS IoT streamed as 1,728 five-minute micro-batches into each system, then queried. “S3” is RustFS with 20 ms added per request."
      />
      <Suspense fallback={<Skeleton className="h-96 rounded-xl" />}>
        <Results />
      </Suspense>
    </>
  )
}

async function Results() {
  const [panels, ingest] = await Promise.all([loadPanels(), loadIngest()])
  return (
    <>
      <BenchCharts panels={panels} suites={[...SUITES]} />
      <Card>
        <CardHeader>
          <CardTitle>Ingest</CardTitle>
          <CardDescription>1,728 commits, 23.3M rows. Timelake includes its inline compaction and snapshot expiry.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Storage</TableHead>
                <TableHead>System</TableHead>
                <TableHead className="text-right">Wall time</TableHead>
                <TableHead className="text-right">Commit p50</TableHead>
                <TableHead className="text-right">Commit p95</TableHead>
                <TableHead className="text-right">Objects written</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ingest.map((r) => (
                <TableRow key={`${r.storage}-${r.system}`}>
                  <TableCell>
                    <Badge variant="outline">{r.storage === "s3" ? "S3 (RustFS +20 ms)" : "local disk"}</Badge>
                  </TableCell>
                  <TableCell className={r.system === "timelake" ? "font-medium" : undefined}>{r.system}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{r.seconds.toFixed(1)} s</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{Math.round(r.p50)} ms</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{Math.round(r.p95)} ms</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{formatNumber(r.objects)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  )
}
