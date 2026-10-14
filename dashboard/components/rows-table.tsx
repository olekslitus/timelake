import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatValue } from "@/lib/format"
import type { Row } from "@/lib/lake/types"

/** Rows sampled to decide whether a column is numeric (right-aligned). */
const TYPE_SAMPLE = 50

/** A generic table for query results. Numbers right-aligned and monospaced. */
export function RowsTable({ rows, max = 500 }: { rows: Row[]; max?: number }) {
  const [first] = rows
  if (!first) return <p className="py-6 text-center text-sm text-muted-foreground">No rows.</p>
  const columns = Object.keys(first)
  const numeric = new Set(
    columns.filter((c) => rows.slice(0, TYPE_SAMPLE).every((r) => r[c] === null || typeof r[c] === "number")),
  )
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
