import { SiteHeader } from "@/components/site-header"

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-xs text-muted-foreground">
          <span>Timelake v0 · private preview</span>
          <span>Built on Apache Iceberg, Apache Arrow, Apache DataFusion and Apache Parquet.</span>
        </div>
      </footer>
    </div>
  )
}
