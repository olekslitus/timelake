import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatValue } from "@/lib/format"
import type { Row } from "@/lib/lake/types"

/** A generic table for query results. Numbers right-aligned and monospaced. */
export function RowsTable({ rows, max = 500 }: { rows: Row[]; max?: number }) {
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">No rows.</p>
  const columns = Object.keys(rows[0])
  const numeric = new Set(columns.filter((c) => rows.slice(0, 50).every((r) => r[c] === null || typeof r[c] === "number")))
  return (
    <div className="space-y-2">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead key={c} className={numeric.has(c) ? "text-right" : undefined}>
                {c}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.slice(0, max).map((r, i) => (
            <TableRow key={i}>
              {columns.map((c) => (
                <TableCell key={c} className={numeric.has(c) ? "text-right font-mono tabular-nums" : "font-mono"}>
                  {formatValue(r[c])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {rows.length > max && (
        <p className="text-xs text-muted-foreground">
          Showing {max} of {rows.length} rows.
        </p>
      )}
    </div>
  )
}
