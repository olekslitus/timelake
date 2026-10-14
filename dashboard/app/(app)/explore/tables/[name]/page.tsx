import { ChevronLeft, Clock, Files, HardDrive, History, Rows3 } from "lucide-react"
import Link from "next/link"
import { Suspense } from "react"

import { ErrorState } from "@/components/error-state"
import { PageHeader } from "@/components/page-header"
import { RowsTable } from "@/components/rows-table"
import { SeriesExplorer } from "@/components/series-explorer"
import { StatCard, StatGrid, StatGridSkeleton } from "@/components/stat-card"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatAgo, formatBytes, formatCompact, formatNumber } from "@/lib/format"
import { attempt, loadTable } from "@/lib/lake"

export default function TablePage({ params }: PageProps<"/explore/tables/[name]">) {
  return (
    <>
      <Link
        href="/explore/tables"
        className="-mb-4 inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" /> Tables
      </Link>
      <Suspense fallback={<StatGridSkeleton count={4} />}>
        <TableView params={params} />
      </Suspense>
    </>
  )
}

const NUMERIC = /^(Int|UInt|Float|Decimal)/

async function TableView({ params }: { params: PageProps<"/explore/tables/[name]">["params"] }) {
  const name = decodeURIComponent((await params).name)
  const res = await attempt(() => loadTable(name))
  if (!res.ok) return <ErrorState error={res.error} />
  const { info, latestRows, now } = res.value
  const key = info.series_key[0] ?? null
  const seriesValues = key
    ? [...new Set(latestRows.map((r) => String(r[key])))].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true }),
      )
    : []
  const numericColumns = info.schema
    .filter((f) => NUMERIC.test(f.type) && !info.series_key.includes(f.name))
    .map((f) => f.name)

  return (
    <>
      <PageHeader
        title={<span className="font-mono">{info.name}</span>}
        description={<span className="font-mono text-xs break-all">{info.location}</span>}
      >
        <div className="flex flex-wrap gap-2">
          {info.time_column ? <Badge>time series</Badge> : <Badge variant="outline">plain table</Badge>}
          {info.chunk && <Badge variant="secondary">{info.chunk} partitions</Badge>}
          {info.time_column && <Badge variant="secondary">dedup {info.dedup ? "on" : "off"}</Badge>}
          <Badge variant="secondary">Iceberg {info.format_version.toLowerCase()}</Badge>
          <Badge variant="outline">v{info.version}</Badge>
        </div>
      </PageHeader>

      <StatGrid>
        <StatCard label="Rows" value={formatCompact(info.rows)} hint={`${formatNumber(info.rows)} rows`} icon={Rows3} />
        <StatCard
          label="Live data"
          value={formatBytes(info.bytes)}
          hint={`${info.files} files · ${info.manifests} manifests`}
          icon={HardDrive}
        />
        <StatCard
          label="Snapshots"
          value={info.snapshot_count}
          hint={info.retention_days ? `data retention ${info.retention_days} d` : "data kept forever"}
          icon={History}
        />
        <StatCard
          label="Last commit"
          value={formatAgo(info.last_commit_ms, now)}
          hint={
            info.last_commit_ms
              ? new Date(info.last_commit_ms).toISOString().replace("T", " ").slice(0, 19) + " UTC"
              : undefined
          }
          icon={Clock}
        />
      </StatGrid>

      <Tabs defaultValue={info.time_column ? "explore" : "data"}>
        <TabsList>
          {info.time_column && <TabsTrigger value="explore">Explore</TabsTrigger>}
          {info.time_column && <TabsTrigger value="latest">Latest values</TabsTrigger>}
          <TabsTrigger value="data">Layout</TabsTrigger>
          <TabsTrigger value="snapshots">Snapshots</TabsTrigger>
        </TabsList>

        {info.time_column && (
          <TabsContent value="explore" className="pt-2">
            <SeriesExplorer table={info.name} seriesKey={key} seriesValues={seriesValues} columns={numericColumns} />
          </TabsContent>
        )}

        {info.time_column && (
          <TabsContent value="latest" className="pt-2">
            <Card>
              <CardHeader>
                <CardTitle>Latest value per series</CardTitle>
                <CardDescription>
                  {formatNumber(latestRows.length)} series, read from the last-value index
                  {info.last_value_index ? "" : " (no index; computed by scan)"}.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <RowsTable rows={latestRows} max={200} />
              </CardContent>
            </Card>
          </TabsContent>
        )}

        <TabsContent value="data" className="grid gap-4 pt-2 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Contract & schema</CardTitle>
              <CardDescription>
                {info.time_column
                  ? `Partitioned by ${info.chunk}(${info.time_column}), sorted by (${[...info.series_key, info.time_column].join(", ")}).`
                  : "No time column: unpartitioned."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Column</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Role</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {info.schema.map((f) => (
                    <TableRow key={f.name}>
                      <TableCell className="font-mono">{f.name}</TableCell>
                      <TableCell className="font-mono text-muted-foreground">
                        {f.type}
                        {f.nullable ? "" : " not null"}
                      </TableCell>
                      <TableCell>
                        {f.name === info.time_column && <Badge>time</Badge>}
                        {info.series_key.includes(f.name) && <Badge variant="secondary">series key</Badge>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Partitions</CardTitle>
              <CardDescription>Newest first. Compaction targets one sorted file per partition.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Partition</TableHead>
                    <TableHead className="text-right">Files</TableHead>
                    <TableHead className="text-right">Rows</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {info.partitions.slice(0, 50).map((p) => (
                    <TableRow key={p.partition}>
                      <TableCell className="font-mono">{p.partition}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        <span className="inline-flex items-center gap-1">
                          {p.files > 1 && <Files className="size-3 text-muted-foreground" />}
                          {p.files}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatNumber(p.rows)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatBytes(p.bytes)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="snapshots" className="pt-2">
          <Card>
            <CardHeader>
              <CardTitle>Snapshots</CardTitle>
              <CardDescription>
                Most recent 50 commits. Appends add data; replace = compaction; delete = retention.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Committed</TableHead>
                    <TableHead>Operation</TableHead>
                    <TableHead className="text-right">Rows added</TableHead>
                    <TableHead className="text-right">Rows removed</TableHead>
                    <TableHead className="text-right">Files ±</TableHead>
                    <TableHead className="text-right">Total rows</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {info.snapshots.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-mono text-xs">
                        {new Date(s.timestamp_ms).toISOString().replace("T", " ").slice(0, 19)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={s.operation === "append" ? "secondary" : "outline"}>{s.operation}</Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {formatNumber(s.added_records)}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {formatNumber(s.deleted_records)}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        +{s.added_files} / −{s.deleted_files}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {formatNumber(s.total_records)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  )
}
