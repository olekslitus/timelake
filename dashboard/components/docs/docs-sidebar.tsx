"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Suspense } from "react"

import { DOCS_NAV, type DocsLink } from "@/lib/docs-nav"
import { cn } from "@/lib/utils"

function NavLink({ link, pathname }: { link: DocsLink; pathname: string | null }) {
  return (
    <Link
      href={link.href}
      className={cn(
        "block rounded-md px-2 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        pathname === link.href && "bg-muted font-medium text-foreground",
      )}
    >
      {link.label}
    </Link>
  )
}

function Nav({ pathname }: { pathname: string | null }) {
  return (
    <nav className="space-y-6 text-sm">
      {DOCS_NAV.map((g) => (
        <div key={g.title} className="space-y-1">
          <div className="label-mono px-2">{g.title}</div>
          {g.items.map((i) => (
            <div key={i.href} className="space-y-1">
              <NavLink link={i} pathname={pathname} />
              {i.items && (
                <div className="ml-2 space-y-1 border-l pl-2">
                  {i.items.map((c) => (
                    <NavLink key={c.href} link={c} pathname={pathname} />
                  ))}
                </div>
              )}
            </div>
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
