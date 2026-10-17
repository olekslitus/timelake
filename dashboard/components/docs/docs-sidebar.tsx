"use client"

import { ChevronRight } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Suspense, useState } from "react"

import { contains, DOCS_NAV, type DocsLink } from "@/lib/docs-nav"
import { cn } from "@/lib/utils"

/**
 * A page link. One with sub-pages has a chevron that shows and hides them; the branch holding the current page opens
 * by itself.
 */
function NavItem({ link, pathname }: { link: DocsLink; pathname: string | null }) {
  const [open, setOpen] = useState(() => contains(link, pathname))
  const [shownFor, setShownFor] = useState(pathname)
  if (pathname !== shownFor) {
    setShownFor(pathname)
    if (contains(link, pathname)) setOpen(true)
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <Link
          href={link.href}
          className={cn(
            "block min-w-0 flex-1 rounded-md px-2 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            pathname === link.href && "bg-muted font-medium text-foreground",
          )}
        >
          {link.label}
        </Link>
        {link.items && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} ${link.label} pages`}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} />
          </button>
        )}
      </div>
      {link.items && open && (
        <div className="ml-2 space-y-1 border-l pl-2">
          {link.items.map((c) => (
            <NavItem key={c.href} link={c} pathname={pathname} />
          ))}
        </div>
      )}
    </div>
  )
}

function Nav({ pathname }: { pathname: string | null }) {
  return (
    <nav className="space-y-6 text-sm">
      {DOCS_NAV.map((g) => (
        <div key={g.title} className="space-y-1">
          <div className="label-mono px-2">{g.title}</div>
          {g.items.map((i) => (
            <NavItem key={i.href} link={i} pathname={pathname} />
          ))}
        </div>
      ))}
    </nav>
  )
}

function ActiveNav() {
  return <Nav pathname={usePathname()} />
}

/** The docs page tree, used by the sidebar and the mobile menu. */
export function DocsNav() {
  return (
    <Suspense fallback={<Nav pathname={null} />}>
      <ActiveNav />
    </Suspense>
  )
}

export function DocsSidebar() {
  return <DocsNav />
}
