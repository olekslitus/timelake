import { Suspense } from "react"

import { ErrorState } from "@/components/error-state"
import { PageHeader } from "@/components/page-header"
import { SqlConsole } from "@/components/sql-console"
import { SqlUnavailable } from "@/components/sql-unavailable"
import { Skeleton } from "@/components/ui/skeleton"
import { attempt, ensureConfigured, SUPPORTS_SQL } from "@/lib/lake"

export default function SqlPage() {
  return (
    <>
      <PageHeader
        title="SQL console"
        description="Read-only DataFusion SQL over the warehouse, through the Timelake reader."
      />
      <Suspense fallback={<Skeleton className="h-64 rounded-xl" />}>
        <Console />
      </Suspense>
    </>
  )
}

async function Console() {
  const res = await attempt(ensureConfigured)
  if (!res.ok) return <ErrorState error={res.error} />
  if (!SUPPORTS_SQL) return <SqlUnavailable />
  return <SqlConsole />
}
