import { ArrowDown, ArrowRight } from "lucide-react"
import { Fragment } from "react"

import { cn } from "@/lib/utils"

type Node = { label: string; sub?: string; accent?: boolean }

/**
 * A row of nodes joined by labelled arrows, for the ingestion guides: where files land, what appends them, and where
 * the tables live. Stacks top to bottom below `lg`, where the docs column is too narrow for a row. `edges[i]` labels the
 * arrow after `nodes[i]`.
 */
export function IngestFlow({ nodes, edges }: { nodes: Node[]; edges: string[] }) {
  return (
    <div className="not-prose my-6 flex flex-col items-stretch rounded-lg border p-4 lg:flex-row lg:items-center">
      {nodes.map((n, i) => (
        <Fragment key={n.label}>
          <div
            className={cn(
              "rounded-md border bg-card px-3 py-2 lg:min-w-0 lg:flex-auto",
              n.accent && "border-[var(--chart-1)] ring-1 ring-[var(--chart-1)]/40",
            )}
          >
            <div className="text-[13px] font-medium">{n.label}</div>
            {n.sub && <div className="font-mono text-[11px] text-muted-foreground">{n.sub}</div>}
          </div>
          {i < nodes.length - 1 && (
            <div className="flex shrink-0 items-center gap-1.5 py-1.5 pl-3 text-[11px] text-muted-foreground lg:flex-col lg:gap-0 lg:px-2 lg:py-0 lg:text-center">
              <ArrowDown className="size-3.5 lg:hidden" aria-hidden />
              <span>{edges[i]}</span>
              <ArrowRight className="hidden size-3.5 lg:block" aria-hidden />
            </div>
          )}
        </Fragment>
      ))}
    </div>
  )
}
