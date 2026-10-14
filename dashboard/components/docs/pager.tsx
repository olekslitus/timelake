import { ArrowLeft, ArrowRight } from "lucide-react"
import Link from "next/link"

import { DOCS_NAV } from "@/lib/docs-nav"

/** Previous / next links in nav order. */
export function Pager({ href }: { href: string }) {
  const flat = DOCS_NAV.flatMap((g) => g.items)
  const i = flat.findIndex((x) => x.href === href)
  const prev = i > 0 ? flat[i - 1] : null
  const next = i >= 0 && i < flat.length - 1 ? flat[i + 1] : null
  return (
    <div className="mt-16 flex justify-between gap-4 border-t pt-6 text-sm">
      {prev ? (
        <Link href={prev.href} className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> {prev.label}
        </Link>
      ) : (
        <span />
      )}
      {next && (
        <Link href={next.href} className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
          {next.label} <ArrowRight className="size-4" />
        </Link>
      )}
    </div>
  )
}

export function DocPage({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <article className="prose-docs min-w-0">
      {children}
      <Pager href={href} />
    </article>
  )
}
