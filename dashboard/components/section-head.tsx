import { ArrowRight } from "lucide-react"
import Link from "next/link"

/** A section's short title with one muted line under it. */
export function SectionHead({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-2xl leading-tight font-light tracking-tight">{label}</h2>
      {children && <p className="text-sm text-muted-foreground">{children}</p>}
    </div>
  )
}

export function MoreLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="flex w-fit items-center gap-1 text-sm hover:underline">
      {children} <ArrowRight className="size-3.5" />
    </Link>
  )
}
