import { SiteHeader } from "@/components/site-header"
import { LICENSE_URL, REPO_URL } from "@/lib/site"

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-xs text-muted-foreground">
          <span>
            Timelake v0 ·{" "}
            <a href={LICENSE_URL} className="underline-offset-4 hover:underline">Apache License 2.0</a> ·{" "}
            <a href={REPO_URL} className="underline-offset-4 hover:underline">GitHub</a>
          </span>
          <span>Built on Apache Iceberg, Apache Arrow, Apache DataFusion and Apache Parquet.</span>
        </div>
      </footer>
    </div>
  )
}
