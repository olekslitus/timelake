import { ChevronLeft, Clock, HardDrive, History, Rows3 } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { Suspense } from "react"

import { ErrorState } from "@/components/error-state"
import { PageHeader } from "@/components/page-header"
import { SeriesExplorer } from "@/components/series-explorer"
import { StatCard, StatGrid, StatGridSkeleton } from "@/components/stat-card"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatAgo, formatBytes, formatCompact, formatNumber, formatUtc } from "@/lib/format"
import { attempt, loadTable } from "@/lib/lake"
import { isNumericType, type TableInfo } from "@/lib/lake/types"

import { LatestValuesCard, PartitionsCard, SchemaCard, SnapshotsCard } from "./cards"

type Props = PageProps<"/explore/tables/[name]">

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: decodeURIComponent((await params).name) }
}

export default function TablePage({ params }: Props) {
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

async function TableView({ params }: Pick<Props, "params">) {
  const name = decodeURIComponent((await params).name)
  const res = await attempt(() => loadTable(name))
  if (!res.ok) return <ErrorState error={res.error} />
  const { info, latest, now } = res.value
  const key = info.series_key[0] ?? null
  const latestRows = latest?.ok ? latest.value : []
  const seriesValues = key
    ? [...new Set(latestRows.map((r) => String(r[key])))].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true }),
      )
    : []
  const numericColumns = info.schema
    .filter((f) => isNumericType(f.type) && !info.series_key.includes(f.name))
    .map((f) => f.name)

  return (
    <>
      <TablePageHeader info={info} />
      <TableStats info={info} now={now} />

      <Tabs defaultValue={info.time_column ? "explore" : "data"}>
        <TabsList>
          {latest && <TabsTrigger value="explore">Explore</TabsTrigger>}
          {latest && <TabsTrigger value="latest">Latest values</TabsTrigger>}
          <TabsTrigger value="data">Layout</TabsTrigger>
          <TabsTrigger value="snapshots">Snapshots</TabsTrigger>
        </TabsList>

        {latest && (
          <TabsContent value="explore" className="pt-2">
            <SeriesExplorer table={info.name} seriesKey={key} seriesValues={seriesValues} columns={numericColumns} />
          </TabsContent>
        )}

        {latest && (
          <TabsContent value="latest" className="pt-2">
            <LatestValuesCard latest={latest} hasIndex={info.last_value_index !== null} />
          </TabsContent>
        )}

        <TabsContent value="data" className="grid gap-4 pt-2 lg:grid-cols-2">
          <SchemaCard info={info} />
          <PartitionsCard partitions={info.partitions} />
        </TabsContent>

        <TabsContent value="snapshots" className="pt-2">
          <SnapshotsCard snapshots={info.snapshots} />
        </TabsContent>
      </Tabs>
    </>
  )
}

function TablePageHeader({ info }: { info: TableInfo }) {
  return (
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
  )
}

function TableStats({ info, now }: { info: TableInfo; now: number }) {
  return (
    <StatGrid>
      <StatCard label="Rows" value={formatCompact(info.rows)} hint={`${formatNumber(info.rows)} rows`} icon={Rows3} />
      <StatCard
        label="Live data"
        value={formatBytes(info.bytes)}
        hint={info.manifests === null ? `${info.files} files` : `${info.files} files · ${info.manifests} manifests`}
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
        hint={info.last_commit_ms ? `${formatUtc(info.last_commit_ms)} UTC` : undefined}
        icon={Clock}
      />
    </StatGrid>
  )
}
