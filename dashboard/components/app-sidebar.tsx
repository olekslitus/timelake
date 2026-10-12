"use client"

import { Suspense } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Database, Gauge, LayoutDashboard, SquareTerminal, Waves } from "lucide-react"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/tables", label: "Tables", icon: Database },
  { href: "/sql", label: "SQL console", icon: SquareTerminal },
  { href: "/benchmarks", label: "Benchmarks", icon: Gauge },
]

function NavMenu({ pathname }: { pathname: string | null }) {
  const active = (href: string) => pathname !== null && (href === "/" ? pathname === "/" : pathname.startsWith(href))
  return (
    <SidebarMenu>
      {NAV.map((item) => (
        <SidebarMenuItem key={item.href}>
          <SidebarMenuButton isActive={active(item.href)} tooltip={item.label} render={<Link href={item.href} />}>
            <item.icon />
            <span>{item.label}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  )
}

function ActiveNavMenu() {
  return <NavMenu pathname={usePathname()} />
}

export function AppSidebar({ warehouse }: { warehouse: string }) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href="/" />}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <Waves className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">Timelake</span>
                <span className="truncate text-xs text-muted-foreground">time-series lake</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Lake</SidebarGroupLabel>
          <SidebarGroupContent>
            {/* The current URL is only known at request time: stream the active state in. */}
            <Suspense fallback={<NavMenu pathname={null} />}>
              <ActiveNavMenu />
            </Suspense>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="group-data-[collapsible=icon]:hidden">
        <div className="px-2 pb-1 text-xs text-muted-foreground">
          <div className="mb-0.5 font-medium text-sidebar-foreground">Warehouse</div>
          <div className="break-all font-mono">{warehouse}</div>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
