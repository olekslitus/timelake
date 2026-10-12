import { Suspense } from "react"

import { ErrorState } from "@/components/error-state"
import { PageHeader } from "@/components/page-header"
import { TablesList, TablesListSkeleton } from "@/components/tables-list"
import { attempt, loadTables } from "@/lib/lake"

export default function TablesPage() {
  return (
    <>
      <PageHeader title="Tables" description="Every table in the warehouse, by namespace." />
      <Suspense fallback={<TablesListSkeleton />}>
        <Tables />
      </Suspense>
    </>
  )
}

async function Tables() {
  const res = await attempt(loadTables)
  if (!res.ok) return <ErrorState error={res.error} />
  return <TablesList tables={res.value.tables} now={res.value.now} />
}
