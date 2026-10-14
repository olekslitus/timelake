import { Files } from "lucide-react"

import { ErrorState } from "@/components/error-state"
import { RowsTable } from "@/components/rows-table"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatBytes, formatNumber, formatUtc } from "@/lib/format"
import type { Attempt } from "@/lib/lake"
import type { Row, TableInfo } from "@/lib/lake/types"

/** Rows shown in the latest-values table. */
const MAX_LATEST_ROWS = 200
/** Newest partitions shown. */
const MAX_PARTITIONS = 50

export function LatestValuesCard({ latest, hasIndex }: { latest: Attempt<Row[]>; hasIndex: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Latest value per series</CardTitle>
        {latest.ok && (
          <CardDescription>
            {formatNumber(latest.value.length)} series,{" "}
            {hasIndex ? "read from the last-value index" : "found by scanning the table (it has no last-value index)"}.
          </CardDescription>
        )}
      </CardHeader>
      <CardContent>
        {latest.ok ? (
          <RowsTable rows={latest.value} max={MAX_LATEST_ROWS} />
        ) : (
          <ErrorState title="Could not read the latest values" error={latest.error} />
        )}
      </CardContent>
    </Card>
  )
}

export function SchemaCard({ info }: { info: TableInfo }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Contract & schema</CardTitle>
        <CardDescription>
          {info.time_column
            ? `Partitioned by ${info.chunk}(${info.time_column}), sorted by (${[...info.series_key, info.time_column].join(", ")}).`
            : "No time column: unpartitioned."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Column</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Role</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {info.schema.map((f) => (
              <TableRow key={f.name}>
                <TableCell className="font-mono">{f.name}</TableCell>
                <TableCell className="font-mono text-muted-foreground">
                  {f.type}
                  {f.nullable ? "" : " not null"}
                </TableCell>
                <TableCell>
                  {f.name === info.time_column && <Badge>time</Badge>}
                  {info.series_key.includes(f.name) && <Badge variant="secondary">series key</Badge>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

export function PartitionsCard({ partitions }: { partitions: TableInfo["partitions"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Partitions</CardTitle>
        <CardDescription>Newest first. Compaction targets one sorted file per partition.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Partition</TableHead>
              <TableHead className="text-right">Files</TableHead>
              <TableHead className="text-right">Rows</TableHead>
              <TableHead className="text-right">Size</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {partitions.slice(0, MAX_PARTITIONS).map((p) => (
              <TableRow key={p.partition}>
                <TableCell className="font-mono">{p.partition}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  <span className="inline-flex items-center gap-1">
                    {p.files > 1 && <Files className="size-3 text-muted-foreground" />}
                    {p.files}
                  </span>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatNumber(p.rows)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatBytes(p.bytes)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

export function SnapshotsCard({ snapshots }: { snapshots: TableInfo["snapshots"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Snapshots</CardTitle>
        <CardDescription>
          Most recent 50 commits. Appends add data; replace = compaction; delete = retention.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Committed</TableHead>
              <TableHead>Operation</TableHead>
              <TableHead className="text-right">Rows added</TableHead>
              <TableHead className="text-right">Rows removed</TableHead>
              <TableHead className="text-right">Files ±</TableHead>
              <TableHead className="text-right">Total rows</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {snapshots.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-mono text-xs">{formatUtc(s.timestamp_ms)}</TableCell>
                <TableCell>
                  <Badge variant={s.operation === "append" ? "secondary" : "outline"}>{s.operation}</Badge>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatNumber(s.added_records)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatNumber(s.deleted_records)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  +{s.added_files} / −{s.deleted_files}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatNumber(s.total_records)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
