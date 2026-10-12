"use client"

import { Suspense } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Menu, Waves } from "lucide-react"

import { ThemeToggle } from "@/components/theme-toggle"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { DOCS_NAV } from "@/lib/docs-nav"
import { cn } from "@/lib/utils"

const LINKS = [
  { href: "/docs", label: "Docs" },
  { href: "/benchmarks", label: "Benchmarks" },
  { href: "/explore", label: "Explorer" },
]

function NavLinks({ pathname }: { pathname: string | null }) {
  return (
    <nav className="hidden items-center gap-1 sm:flex">
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground",
            pathname?.startsWith(l.href) && "text-foreground",
          )}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  )
}

function ActiveNavLinks() {
  return <NavLinks pathname={usePathname()} />
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Waves className="size-4" />
          </span>
          Timelake
        </Link>
        <Suspense fallback={<NavLinks pathname={null} />}>
          <ActiveNavLinks />
        </Suspense>
        <div className="flex-1" />
        <ThemeToggle />
        <Sheet>
          <SheetTrigger render={<Button variant="ghost" size="icon" className="sm:hidden" aria-label="Open menu" />}>
            <Menu className="size-4" />
          </SheetTrigger>
          <SheetContent side="left" className="w-72 overflow-y-auto">
            <SheetHeader>
              <SheetTitle>Timelake</SheetTitle>
            </SheetHeader>
            <div className="space-y-6 px-4 pb-6">
              <div className="space-y-1">
                <Link href="/" className="block py-1 text-sm">Home</Link>
                <Link href="/benchmarks" className="block py-1 text-sm">Benchmarks</Link>
                <Link href="/explore" className="block py-1 text-sm">Explorer</Link>
              </div>
              {DOCS_NAV.map((g) => (
                <div key={g.title} className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground">{g.title}</div>
                  {g.items.map((i) => (
                    <Link key={i.href} href={i.href} className="block py-1 text-sm">
                      {i.label}
                    </Link>
                  ))}
                </div>
              ))}
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  )
}
