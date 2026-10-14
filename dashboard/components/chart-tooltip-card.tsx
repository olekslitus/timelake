import { Fragment } from "react"

/** The tooltip box of the site's charts: a title over label/value rows. */
export function ChartTooltipCard({
  title,
  rows,
}: {
  title: React.ReactNode
  rows: [label: string, value: React.ReactNode][]
}) {
  return (
    <div className="rounded-lg border bg-background px-3 py-2 text-xs shadow-sm">
      <div className="mb-1 font-medium">{title}</div>
      <div className="grid grid-cols-[auto_auto] gap-x-4 font-mono tabular-nums">
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <span className="text-muted-foreground">{label}</span>
            <span className="text-right">{value}</span>
          </Fragment>
        ))}
      </div>
    </div>
  )
}
