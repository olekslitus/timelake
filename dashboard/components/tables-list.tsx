import Link from "next/link"
import { Clock, Table2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatAgo, formatBytes, formatCompact, tableHref } from "@/lib/format"
import type { TableInfo } from "@/lib/lake/types"

export function TablesList({ tables, now }: { tables: TableInfo[]; now: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Tables</CardTitle>
        <CardDescription>Live data in each table&apos;s current snapshot.</CardDescription>
      </CardHeader>
      <CardContent>
        {tables.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No tables yet. Create one with <code className="font-mono">timelake import</code>.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Table</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead className="text-right">Rows</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead className="text-right">Files</TableHead>
                <TableHead className="text-right">Partitions</TableHead>
                <TableHead className="text-right">Last commit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tables.map((t) => (
                <TableRow key={t.name}>
                  <TableCell>
                    <Link href={tableHref(t.name)} className="flex items-center gap-2 font-medium hover:underline">
                      <Table2 className="size-4 text-muted-foreground" />
                      <span className="font-mono">{t.name}</span>
                    </Link>
                  </TableCell>
                  <TableCell>
                    {t.time_column ? (
                      <Badge variant="secondary">time series · {t.chunk}</Badge>
                    ) : (
                      <Badge variant="outline">plain</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{formatCompact(t.rows)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{formatBytes(t.bytes)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{t.files}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{t.partitions.length}</TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Clock className="size-3" />
                      {formatAgo(t.last_commit_ms, now)}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

export function TablesListSkeleton() {
  return <Skeleton className="h-72 rounded-xl" />
}
