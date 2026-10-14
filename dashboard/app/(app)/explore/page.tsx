import { Database, HardDrive, History, Rows3 } from "lucide-react"
import type { Metadata } from "next"
import { Suspense } from "react"

import { ErrorState } from "@/components/error-state"
import { PageHeader } from "@/components/page-header"
import { StatCard, StatGrid, StatGridSkeleton } from "@/components/stat-card"
import { TablesList, TablesListSkeleton } from "@/components/tables-list"
import { formatBytes, formatCompact, formatNumber } from "@/lib/format"
import { attempt, loadTables } from "@/lib/lake"

export const metadata: Metadata = { title: "Explorer" }

export default function OverviewPage() {
  return (
    <>
      <PageHeader title="Overview" description="Tables, size and freshness of the warehouse." />
      <Suspense
        fallback={
          <>
            <StatGridSkeleton />
            <TablesListSkeleton />
          </>
        }
      >
        <Overview />
      </Suspense>
    </>
  )
}

async function Overview() {
  const res = await attempt(loadTables)
  if (!res.ok) return <ErrorState error={res.error} />
  const { tables, now } = res.value
  const rows = tables.reduce((s, t) => s + t.rows, 0)
  const bytes = tables.reduce((s, t) => s + t.bytes, 0)
  const files = tables.reduce((s, t) => s + t.files, 0)
  const snapshots = tables.reduce((s, t) => s + t.snapshot_count, 0)
  const series = tables.filter((t) => t.time_column).length
  return (
    <>
      <StatGrid>
        <StatCard
          label="Tables"
          value={tables.length}
          hint={`${series} time series · ${tables.length - series} plain`}
          icon={Database}
        />
        <StatCard label="Rows" value={formatCompact(rows)} hint={`${formatNumber(rows)} rows`} icon={Rows3} />
        <StatCard label="Live data" value={formatBytes(bytes)} hint={`${files} Parquet files`} icon={HardDrive} />
        <StatCard label="Snapshots" value={snapshots} hint="retained for time travel" icon={History} />
      </StatGrid>
      <TablesList tables={tables} now={now} />
    </>
  )
}
