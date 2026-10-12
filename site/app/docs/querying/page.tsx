import type { Metadata } from "next"

import { DocPage } from "@/components/docs/pager"

export const metadata: Metadata = { title: "Querying" }

export default function Page() {
  return (
    <DocPage href="/docs/querying">
      <h1>Querying</h1>
      <p>
        The Timelake reader is Apache DataFusion with a Timelake table provider. You write standard SQL (DataFusion’s dialect);
        tables are addressed as <code>namespace.table</code> and always read at their latest committed version.
      </p>

      <h2>Time buckets</h2>
      <p>
        <code>time_bucket(interval, ts [, origin])</code> works as in TimescaleDB. It is DataFusion’s <code>date_bin</code>{" "}
        under another name: buckets are aligned to the Unix epoch unless you pass an origin.
      </p>
      <pre>{`SELECT device_id, time_bucket(INTERVAL '5 minutes', time) AS bucket, avg(temp), max(temp)
FROM iot.readings
WHERE time >= now() - INTERVAL '1 day'
GROUP BY 1, 2`}</pre>

      <h2>What the reader accelerates</h2>
      <h3>Time and series filters</h3>
      <p>
        Filters are evaluated against each file’s Iceberg column bounds before any data is read, so a time range or a series
        key value skips whole files. Inside the sorted Parquet files, row-group statistics and page indexes skip the rest.
      </p>
      <h3>Latest row per series</h3>
      <p>This query shape is rewritten to read the last-value index instead of scanning the table:</p>
      <pre>{`SELECT * FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY time DESC) AS rn
  FROM iot.readings
) WHERE rn = 1`}</pre>
      <p>
        The <code>PARTITION BY</code> columns must be exactly the series key and the ordering must be the time column
        descending. Other predicates combined with <code>rn = 1</code> are applied to the latest rows, as the SQL means.
      </p>
      <h3>Latest row matching a series filter</h3>
      <pre>{`SELECT * FROM iot.readings WHERE device_id = 'pump-7' ORDER BY time DESC LIMIT 1`}</pre>
      <p>
        Rewritten to the index when the filters reference only series key columns and the limit is 1. A filter on any other
        column (for example <code>temp &gt; 80</code>) keeps the normal scan, because the latest matching row may not be the
        latest row.
      </p>
      <p>
        Both rewrites need a last-value index, which every append maintains. Check with <code>EXPLAIN</code>: a rewritten
        query reads an in-memory source instead of Parquet files.
      </p>

      <h3>Object storage</h3>
      <p>
        Before planning, the reader loads every table a query references concurrently (version hint, metadata, manifests,
        last-value index), and it reads each Parquet footer once. On remote stores it uses more scan partitions than cores
        (4× cores, at least 32) because the work is latency-bound. Table versions loaded for planning are reused for one
        second within a process; the process’s own commits are always visible immediately.
      </p>

      <h2>Joins with plain tables</h2>
      <pre>{`SELECT d.site, avg(r.temp)
FROM iot.readings r JOIN iot.devices d USING (device_id)
WHERE r.time >= TIMESTAMP '2026-01-03 00:00:00'
GROUP BY 1`}</pre>

      <h2>Reading with DuckDB</h2>
      <p>
        Timelake tables follow Iceberg’s Hadoop-catalog layout, so DuckDB’s iceberg extension reads a table directory directly.
        It sees committed data and none of the reader’s rewrites.
      </p>
      <pre>{`INSTALL iceberg; LOAD iceberg;
SELECT * FROM iceberg_scan('s3://my-bucket/lake/iot/readings');
-- the last-value index is plain Parquet; timelake duckdb <table> prints its current location
SELECT * FROM read_parquet('s3://my-bucket/lake/iot/readings/metadata/lvi-….parquet');`}</pre>
      <p>
        Duplicates written since the last compaction are visible to DuckDB until compaction removes them; the Timelake reader
        sees the same rows.
      </p>
    </DocPage>
  )
}
