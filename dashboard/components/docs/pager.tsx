"use client"

import { ArrowLeft, ArrowRight } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Suspense } from "react"

import { DOCS_PAGES as PAGES } from "@/lib/docs-nav"

function PagerLinks() {
  const pathname = usePathname()
  const i = PAGES.findIndex((p) => p.href === pathname)
  const prev = i > 0 ? PAGES[i - 1] : undefined
  const next = i >= 0 ? PAGES[i + 1] : undefined
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

/** Previous / next links in sidebar order (lib/docs-nav.ts). */
export function DocsPager() {
  return (
    <Suspense>
      <PagerLinks />
    </Suspense>
  )
}
