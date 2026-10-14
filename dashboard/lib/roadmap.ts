/** The public roadmap at /roadmap. A plain-words view of SPEC.md §19 and §21: change them together. */

export type RoadmapItem = {
  title: string
  description: string
  /** Only items under "Now" have one. */
  status?: "done" | "next"
}

export const ROADMAP_UPDATED = "October 2026"

export const NOW: RoadmapItem[] = [
  {
    title: "Industrial IoT benchmark",
    description: "Timelake against InfluxDB, TimescaleDB, ClickHouse and QuestDB, with the monthly cost of each.",
    status: "next",
  },
  {
    title: "Faster first queries",
    description:
      "A table's state, file footers included, is read in one request. First queries take a third to half the time.",
    status: "done",
  },
  {
    title: "Faster commits",
    description: "Everything a commit needs is uploaded at once, then published in one step: twice as fast.",
    status: "done",
  },
  {
    title: "Open tables on any object store",
    description:
      "Parquet and Iceberg on S3, R2, GCS, Azure or a disk. Use them from the CLI, Python, a browser or DuckDB.",
    status: "done",
  },
  {
    title: "No maintenance jobs",
    description: "Compaction, deduplication, retention and cleanup run inside the writer.",
    status: "done",
  },
  {
    title: "Latest value of every series",
    description: "Answered from a small index in a few requests, not a scan.",
    status: "done",
  },
]

export const COMING_UP: RoadmapItem[] = [
  { title: "Rollups", description: "Hourly and daily summaries that stay up to date as data lands." },
  {
    title: "Time-series functions",
    description: "Gap filling, time-weighted averages, counters and percentiles.",
  },
  {
    title: "Any engine can attach",
    description: "An Iceberg REST catalog, so Snowflake, Trino, Athena and Spark query tables in place.",
  },
  { title: "Deletes and GDPR erasure", description: "Audited deletes you can undo, and purges within 7 days." },
  {
    title: "Import and backfill",
    description: "Bring history from TimescaleDB, Iceberg or S3 Tables, and publish it all at once.",
  },
  { title: "Seconds-fresh data", description: "New rows visible within a second, before they are committed." },
  { title: "Ingestion with rules", description: "MQTT, HTTP and Kafka in, with rules and alerts as data arrives." },
  { title: "Local cache", description: "Repeat queries served from disk instead of the bucket." },
  { title: "DuckDB extension", description: "Timelake's speedups and functions inside DuckDB." },
]

export const EXPLORING: RoadmapItem[] = [
  { title: "Agent access", description: "AI agents query your data within the permissions you set." },
  { title: "Dashboard read models", description: "Small ready-made files for frontends, refreshed on every write." },
  { title: "Data to events", description: "Turn new data into events on any stream." },
  { title: "Computed metrics", description: "Your Python functions, applied automatically like rollups." },
  { title: "Edge and device sync", description: "Write on devices and gateways; Timelake moves it to the lake." },
  { title: "Server mode", description: "Timelake as a database on one machine, with the bucket as the copy." },
]
