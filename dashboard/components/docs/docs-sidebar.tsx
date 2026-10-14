"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Suspense } from "react"

import { DOCS_NAV } from "@/lib/docs-nav"
import { cn } from "@/lib/utils"

function Nav({ pathname }: { pathname: string | null }) {
  return (
    <nav className="space-y-6 text-sm">
      {DOCS_NAV.map((g) => (
        <div key={g.title} className="space-y-1">
          <div className="label-mono px-2">{g.title}</div>
          {g.items.map((i) => (
            <Link
              key={i.href}
              href={i.href}
              className={cn(
                "block rounded-md px-2 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                pathname === i.href && "bg-muted font-medium text-foreground",
              )}
            >
              {i.label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  )
}

function ActiveNav() {
  return <Nav pathname={usePathname()} />
}

export function DocsSidebar() {
  return (
    <Suspense fallback={<Nav pathname={null} />}>
      <ActiveNav />
    </Suspense>
  )
}
