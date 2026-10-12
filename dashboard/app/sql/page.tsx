import { PageHeader } from "@/components/page-header"
import { SqlConsole } from "@/components/sql-console"

export default function SqlPage() {
  return (
    <>
      <PageHeader title="SQL console" description="Read-only DataFusion SQL over the warehouse, through the Timelake reader." />
      <SqlConsole />
    </>
  )
}
