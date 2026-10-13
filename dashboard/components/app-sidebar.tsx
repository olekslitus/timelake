"use client"

import { Suspense } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { BookOpen, Database, Gauge, House, LayoutDashboard, SquareTerminal } from "lucide-react"

import { TimelakeMark } from "@/components/brand/timelake-mark"

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
  { href: "/explore", label: "Overview", icon: LayoutDashboard },
  { href: "/explore/tables", label: "Tables", icon: Database },
  { href: "/explore/sql", label: "SQL console", icon: SquareTerminal },
]

const LINKS = [
  { href: "/", label: "Home", icon: House },
  { href: "/docs", label: "Docs", icon: BookOpen },
  { href: "/benchmarks", label: "Benchmarks", icon: Gauge },
]

function NavMenu({ pathname }: { pathname: string | null }) {
  const active = (href: string) =>
    pathname !== null && (href === "/explore" ? pathname === "/explore" : pathname.startsWith(href))
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
            <SidebarMenuButton size="lg" render={<Link href="/explore" />}>
              <div className="flex aspect-square size-8 items-center justify-center">
                <TimelakeMark className="!size-7" />
              </div>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate text-[17px] font-medium tracking-[-0.045em]">timelake</span>
                <span className="label-mono truncate text-[10px]">explorer</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Explorer</SidebarGroupLabel>
          <SidebarGroupContent>
            {/* The current URL is only known at request time: stream the active state in. */}
            <Suspense fallback={<NavMenu pathname={null} />}>
              <ActiveNavMenu />
            </Suspense>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Timelake</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {LINKS.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton tooltip={item.label} render={<Link href={item.href} />}>
                    <item.icon />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
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
