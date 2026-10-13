# Timelake — Specification

> **Status:** Draft v0.8 — v0 implementation in progress (§19.0)
> **Last updated:** 2026-10-13
> **Scope of this document:** product requirements, architecture, and the key design decisions (with open questions). Not an implementation guide yet.

### Decision log
| ID | Decision | Status |
|----|----------|--------|
| D1 | Build on Apache Iceberg; no custom table format (§5.1) | **Accepted** |
| D2 | Ship our own Iceberg REST catalog, `timelake-catalog`, that is optional and scales to zero (§5.2) | **Accepted** |
| D3 | DataFusion as the embedded engine; shared function kernels; DuckDB extension as the user-facing SQL path (§5.3) | Proposed, pending a Phase 0 spike |
| D4 | Any database-backed component (hot store, catalog DB) is an optional performance upgrade, never a requirement | **Accepted** |
| D5 | User-defined schemas with a hypertable-like contract (§7) | **Accepted** |
| D6 | Deletes are immutable: logical, audited, and reversible; physical purge is a separate explicit operation (§9.2) | **Accepted** |
| D7 | License: **Apache License 2.0** for everything in this repository. Apache 2.0's explicit patent grant suits infrastructure that companies embed, and it matches Iceberg, Arrow, DataFusion and Parquet. The repository is public (2026-10-12). AGPLv3 + CLA and FSL were considered to keep cloud vendors from hosting it, and rejected: an open-format, no-lock-in project wins by adoption (the PostgreSQL/Iceberg/DuckDB path), late restrictions are answered by forks (Valkey, OpenSearch), and an API can be reimplemented regardless of license (DocumentDB). Protection comes from the trademark, being the reference implementation, and a hosted service plus premium add-ons (§20). | **Accepted** |
| D8 | GDPR erasure is supported: immediate logical delete, then a batched physical purge (daily by default, `--now` on demand, alert past 7 days), covering every copy of the data (§9.3). No legal hold / WORM in v1. | **Accepted** |
| D9 | Backfill is a first-class operation: one command, final layout on write, staged on an Iceberg branch, atomic publish; existing rows win on conflict by default (§8.4) | **Accepted** |
| D10 | `import` = contract inference + create/adopt + backfill, with smart defaults for CSV, lake formats, and databases (TimescaleDB first) (§8.5) | **Accepted** |
| D11 | Ingestion is a library-first pipeline (ingest + rules) deployable embedded, as AWS Lambda, as a container, or at the edge (§13) | **Accepted** |
| D12 | Open core: the lake, ingestion, caggs, import of open formats/DBs, and the DuckDB extension are open source. Industrial historian connectors are a **premium** offering (§20). | Proposed |
| D13 | Timelake owns its commit layer (append, replace, row-delta, overwrite, branch commits, rewrite-manifests) on iceberg-rust's public types. Forking and maintaining our own iceberg-rust is acceptable if needed. Upstreaming is welcome but low priority. Iceberg Java, iceberg-cpp, and iceberg-go serve as **reference implementations** to port from and as **conformance oracles** in tests (Phase 0 finding, `spikes/iceberg-write`) | **Accepted** |
| D14 | Rust for the core, even where we must implement Iceberg operations ourselves. Python is the client/API layer (PyO3), not the engine. | **Accepted** |
| D15 | `timelake-bench`: TSBS IoT as the base workload plus lake extensions, run against every alternative in §16 (§17) | **Accepted** |
| D16 | Parquet stays the lake's source of truth (Iceberg-compatible). Vortex is used where Timelake owns the read path and data is local: reader SSD cache, hot tier, edge. Re-evaluate when Iceberg supports Vortex files or Vortex object-store I/O matures (`bench/results/VORTEX.md`). | Proposed |
| D17 | v0 catalog layout is Hadoop-catalog compatible: `<table>/metadata/vN.metadata.json` committed with put-if-absent, plus `version-hint.text`. Plain DuckDB `iceberg_scan('<table dir>')` and Spark's HadoopCatalog read tables with no catalog service. A REST endpoint can serve the same layout later (§5.2). | **Accepted (v0)** |
| D18 | The last-value index is a per-snapshot **Parquet sidecar** referenced from the snapshot summary (`timelake.last-value-index`), not a Puffin blob: any engine can read it, and it is rewritten incrementally on each append (previous index ⊕ newest rows of the batch). | **Accepted (v0)** |
| D19 | Inline maintenance uses **size-tiered compaction** (merge ≥ N files of similar size within a partition) to keep write amplification logarithmic under micro-batches. Explicit `maintain` rewrites each partition into one sorted, deduplicated file. | **Accepted (v0)** |
| D20 | v0 pins **DataFusion 54.1**, the newest release on Arrow 58, which iceberg-rust 0.10 requires. Revisit when iceberg-rust moves to Arrow 59+. | **Accepted (v0)** |
| D21 | Benchmarks compare against every opponent (InfluxDB 3, TimescaleDB, ClickHouse, QuestDB, naive Iceberg, Lance), publish where Timelake is worse as well as better, and always report cost per month and behavior as data grows next to latency (§17.6). | **Accepted** |

---

## 1. Vision

**Timelake is an open-source, serverless time-series lake built on Apache Iceberg.**

Think "S3 Tables, but open source, runs on any object storage, and actually understands time series": frequent small writes, late and out-of-order data, rollups (continuous aggregates), retention, and a rich time-series function library — while every byte stays as plain Iceberg + Parquet that DuckDB, Spark, Trino, Snowflake, etc. can read directly.

Primary target: **IoT / industrial telemetry.** Also supports observability metrics, financial ticks, and event streams.

The problem we replace: teams today run S3 Tables (or self-managed Iceberg) plus **custom Glue/Spark jobs** to compact, re-sort, downsample, and expire time-series data. Timelake makes that a library + a few stateless jobs with sane defaults.

---

## 2. Requirements (as stated)

| ID | Requirement |
|----|-------------|
| R1 | Maximum compatibility with existing tools — e.g. query with plain DuckDB. |
| R2 | Build on Apache Iceberg. Open-source alternative to S3 Tables, works on any object storage, specialized for time series (frequent writes, late-arriving data, …). |
| R3 | Parquet as the first file format; keep the door open for Vortex once Iceberg supports it. |
| R4 | Pluggable in-memory cache/hot layer for recent data (Valkey/Redis, DuckDB). |
| R5 | Simple continuous aggregates (caggs) and a time-series function library on par with TimescaleDB (+ Toolkit). |
| R6 | Willing to build a custom table format *if justified* — to be decided (see §5). |
| R7 | Easier to use and faster for time series than DuckLake, S3 Tables, Lance, etc. |
| R8 | Support all time-series shapes; IoT is the primary target. |
| R9 | Explain how Apache Arrow and DataFusion fit (see §4). |
| R10 | Core/application layer in Rust; Python library for retrieval; plain SQL via DuckDB. |
| R11 | Firehose-like ingestion service with in-stream compute: irregular-data detection, alarm events, etc. |
| R12 | Good documentation with use-case examples (multitenancy, …). |
| R13 | No mandatory server — scale cheaply; replace "S3 Tables + custom Glue jobs". |
| R14 | Provide a retrieval library faster than DuckDB where possible. |
| R15 | Instant data access; batch and continuous ingestion; an optional small managed DB is acceptable, and users can opt out of it in exchange for documented limitations. |
| R16 | Backfilling historical data must be easy. |
| R17 | Deletes are immutable and audited, *and* GDPR-compliant erasure is possible. |
| R18 | Simple import from CSV files, existing stores (Iceberg/S3 Tables, Parquet, …), and databases such as TimescaleDB. |
| R19 | Easy read access to the data for LLM agents, with permission sets built in (§21.1). |
| R20 | Pre-made static read models on the blob store, based on the frontend's Zod schemas, invalidated and regenerated automatically on ingestion, so dashboards for a time range of a device or asset are near instant (§21.2). |
| R21 | Data → events: produce any type of event into any event stream system, based on incoming data (§21.3). |
| R22 | Later: a simple compute model. Users define a Python function and the result it should produce (for example a computed metric), and Timelake applies it automatically, the way it does rollups (§21.4). |

---

## 3. Goals and non-goals

### Goals
- **G1 — Open by default:** Data is valid Iceberg (v2, targeting v3). No Timelake software is needed to *read* committed data.
- **G2 — Time-series native:** Time-aware partitioning, sort order, compaction, retention, rollups, late-data handling, dedup.
- **G3 — Serverless and cheap:** All durable state lives in object storage + an Iceberg catalog. Every Timelake component is stateless or embeddable and can run as a library, a cron/k8s job, a Lambda, or a sidecar.
- **G4 — Fresh:** Seconds-level visibility through Timelake readers when a hot tier is enabled; minutes-level when it is not.
- **G5 — Fast on time-series query shapes:** Faster than generic engines on the query shapes that matter (last value, range scan for a few series, bucketed aggregates), because we exploit layout, indexes, and rollups.
- **G6 — Batteries included:** Ingestion, stream rules/alarms, caggs, a Python client, and docs with real-world recipes.

### Non-goals (for now)
- An OLTP database or a general-purpose warehouse.
- Full-text log search or vector search.
- A new query language. SQL is the interface.
- Making *any* always-on service mandatory. `timelake-catalog` is recommended but optional, and Timelake works with third-party Iceberg catalogs at reduced capability (§5.2).

---

## 4. Primer: how the pieces fit (R9)

| Layer | Technology | Role in Timelake |
|-------|------------|------------------|
| **Object storage** | S3, GCS, Azure Blob, MinIO, R2, local disk | Holds all data and metadata files. Accessed via the Rust `object_store` crate. |
| **File format** | **Apache Parquet** (later Vortex) | Columnar *on-disk* format. Compressed, with per-column statistics (min/max/null counts) and page indexes that let readers skip data. |
| **Table format** | **Apache Iceberg** | Turns a pile of Parquet files into a *table*: schema, partitioning, snapshots (time travel), atomic commits, and file-level statistics in manifests. This is what makes DuckDB/Spark/Trino able to read our data. |
| **Catalog** | **`timelake-catalog`** (ours, §5.2) or any Iceberg REST catalog (Lakekeeper, Polaris, Glue, S3 Tables, Nessie, …) | Maps table names to the current metadata file and makes commits atomic. Every commit and every reader goes through it. |
| **In-memory format** | **Apache Arrow** | Columnar *in-memory* format and the lingua franca between systems. Rust, Python (PyArrow/Polars/pandas), and DuckDB can exchange Arrow data **zero-copy**. We use Arrow for every in-flight batch: ingestion buffers, WAL segments (Arrow IPC), query results, and the Python API. |
| **Query engine (embedded)** | **Apache DataFusion** | Rust library containing a SQL parser, planner, optimizer, and vectorized executor that operates on Arrow. It is *not* a server; we embed it. We extend it with custom table providers (our pruning + hot-tier merge), UDFs/UDAFs (time-series functions), and optimizer rules (route queries to caggs). It powers compaction, cagg refresh, in-stream rules, and the Timelake reader. |
| **Iceberg in Rust** | `iceberg-rust` (Apache) | Rust implementation of the Iceberg spec, including catalog clients and a DataFusion integration. Our base for reading and writing Iceberg metadata. |
| **External engines** | DuckDB, Spark, Trino, Snowflake, Athena | Read our Iceberg tables directly. DuckDB is the first-class "plain SQL" path (R1, R10). |

In short, **Parquet** is how data sits on disk, **Iceberg** is how files become tables, **Arrow** is how data moves in memory, and **DataFusion** is the engine we embed to compute on it.

---

## 5. Key decisions

## 5.1 D1: Iceberg vs. a custom table format (R2, R6) — **Accepted: Iceberg**

**Iceberg is the source of truth. We add "Timelake conventions" on top using only Iceberg's extension points.**

Iceberg already provides the mechanisms we need to add time-series intelligence *without breaking other readers*:

| Extension point | What we store there | Other engines |
|-----------------|--------------------|---------------|
| Table properties (`timelake.*`) | Table kind (raw / cagg / events), time column, series key, dedup policy, retention, cagg definitions | Ignore |
| Snapshot summary properties | Ingest watermarks (WAL offsets), changed time ranges per commit, idempotency/batch IDs | Ignore |
| Puffin statistics files | Series→file index, per-series time ranges, "last value" index, sketches | Ignore unknown blobs (*to verify per engine*) |
| Sort order + partition spec | `(series_key…, time_column)` sort; time + bucket partitioning | Use for pruning |
| Sidecar Iceberg tables | Series/device metadata, caggs, events/alarms | Fully readable |

### Why not a custom format (yet)
- **Ecosystem:** Iceberg is readable by DuckDB, Spark, Trino, Flink, Snowflake, BigQuery, Athena, and Databricks. A custom format would forfeit R1.
- The known Iceberg weaknesses for time series are **commit overhead** (each commit writes metadata.json + a manifest list + manifests) and **commit throughput** (optimistic concurrency at the catalog). Both are addressable *around* Iceberg:
  - Batch commits: a single committer per table, committing every N seconds or N MB.
  - A hot tier for sub-commit freshness (§8).
  - Aggressive manifest compaction and snapshot expiration.
  - Adopting Iceberg v4 improvements (proposed single-file commits / adaptive metadata tree) when they land.
- DuckLake chose a SQL database as its catalog largely to solve small commits and fast metadata. Our hot tier plays the same role *optionally*, and keeps the lake itself pure Iceberg.

### When we would revisit
We revisit if benchmarks show that Iceberg metadata planning dominates latency for typical queries even after Puffin indexes and metadata caching. Even then, the fallback is a **Timelake index layer that accelerates Iceberg**, not a replacement for it.

## 5.2 D2: Our own catalog, `timelake-catalog` — **Accepted**

A catalog alone doesn't make data faster to scan: file layout, compaction, and indexes do that, and they work with any catalog. What a catalog we control *does* optimize is everything around those:

| Lever | What `timelake-catalog` does | Without it (third-party catalog) |
|-------|------------------------------|----------------------------------|
| **Commit throughput** | Queues commits per table server-side and can coalesce concurrent append-only commits into one snapshot. No retry storms from optimistic concurrency (OCC) conflicts. | Writers retry on conflict; need a single committer per table |
| **Metadata latency** | Caches table metadata, manifests, and Puffin indexes in memory | Every reader re-fetches from object storage |
| **Server-side scan planning** | Implements the Iceberg REST scan-planning endpoints using our series/time indexes, so any engine that delegates planning gets Timelake pruning | Engines only use min/max statistics |
| **Maintenance triggers** | Emits commit events that drive compaction and cagg refresh as work arrives, with no polling or schedules | Cron schedules |
| **Timelake state** | Stores hot-tier watermarks, cagg registry, retention policies, delete audit log, tenant configuration | Stored in table properties / snapshot summaries (works, but slower to query) |
| **Security / multitenancy** | AuthN/Z, scoped credential vending (STS / presigned URLs), per-tenant quotas | Whatever the third-party catalog offers |

**Design constraints (to stay true to R13):**
- **Implements the standard Iceberg REST spec.** DuckDB, Spark, Trino, PyIceberg, and Snowflake attach unchanged.
- **Stateless process:**
  - Default backend is *object storage only*: the current-metadata pointer is swapped with conditional writes, so no database is needed.
  - Postgres is an optional backend for very high commit rates or many tables.
- **Scale-to-zero friendly:** Deployable as a Lambda / Cloud Run function, a container, or **in-process as a library** for single-node and edge setups.
- **Optional:** All Timelake features degrade gracefully on S3 Tables, Glue, Polaris, or Lakekeeper (right-hand column above).

**Build vs. extend:** Lakekeeper is an Apache-2.0 Iceberg REST catalog written in Rust. In Phase 0 we evaluate extending or forking it versus building a focused catalog on `iceberg-rust`. *Open question Q2.*

## 5.3 D3: Why an embedded engine, and why DataFusion — **Proposed**

**Why we need an embedded engine at all.** Several Timelake components must execute queries *inside our own Rust processes*:
- **Compaction:** k-way merge of sorted files, dedup, re-sort.
- **Cagg refresh:** `GROUP BY time_bucket(…)` over changed ranges.
- **Ingest transforms and rules:** SQL over streaming batches.
- **Server-side scan planning** in the catalog.
- **The Timelake reader** and Python library.

Writing all of that by hand would mean reimplementing a query engine.

**Options considered**

| Option | Pros | Cons |
|--------|------|------|
| **DataFusion** | Native Rust. Arrow-native (no conversions). Extensible at every layer: custom table providers (our pruning + hot-tier merge), optimizer rules (cagg routing), custom physical operators (sorted merge/dedup), UDAFs with state. Streaming execution with memory limits (good for compaction in small Lambdas). Integrates with `iceberg-rust`. Proven in time-series systems (InfluxDB 3, GreptimeDB). Apache governance. | Fast-moving API (major releases are frequent, so we pin versions). Comparable to DuckDB on many benchmarks, not uniformly faster. |
| **Embedded DuckDB** (`duckdb-rs`) | Excellent performance. One engine everywhere. Users already know it. | C++ dependency complicates cross-compiling for edge/ARM/Lambda. Deep customization (scan pruning, optimizer, operators) must happen through C++ extensions. Data crosses a Rust↔C++ boundary. |
| **Polars** | Fast DataFrame engine | DataFrame-first; limited SQL planner extensibility; weak fit for custom scans and streaming SQL rules |
| **Hand-written only** | Maximum speed for specific shapes | Reinventing a query engine |

**Proposal**
1. **DataFusion** is the internal engine for compaction, caggs, rules, the catalog planner, and the Timelake reader.
2. **Hand-written fast paths** (directly on `arrow-rs`/`parquet`) cover the hottest query shapes where we want to beat any general engine: last value, single-series range reads, cagg point lookups.
3. **The DuckDB extension is the primary user-facing SQL path.** Users keep DuckDB; we make it Timelake-aware.
4. **One function implementation, two engines:** time-series kernels live in an engine-agnostic crate, `timelake-functions`, that operates on Arrow arrays. Thin adapters expose them as DataFusion UDFs/UDAFs and as DuckDB extension functions (Rust via the DuckDB C extension API; *verify aggregate-function coverage*).

**Phase 0 spike to confirm:** Implement compaction (merge + dedup) and one cagg refresh in both DataFusion and embedded DuckDB. Compare throughput, memory, binary size, and build complexity.

---

## 6. Architecture overview

```
  Devices / MQTT /     ┌───────────────────────────────────────────────┐
  Kafka / HTTP /  ───► │ timelake-ingest (stateless)                   │
  Arrow Flight         │ decode → validate → transform → rules/alarms  │
                       │ → buffer → WAL append → lake commit           │
                       └──────┬────────────────┬────────────────┬──────┘
                              │ events/alarms  │ recent data    │ Parquet + commit
                              ▼                ▼                ▼
                      sinks (webhook,    ┌───────────┐   ┌──────────────────────┐    ┌─────────────────────┐
                      Kafka, SNS) +      │ Hot tier  │   │ Iceberg tables on    │◄───┤ timelake backfill   │
                      events table       │ (optional)│   │ object storage       │    │ branch → publish    │
                                         │ S3 WAL /  │   │ raw / caggs / events │    │ ◄ files, DBs,       │
                                         │ Valkey /  │   │ / series metadata    │    │   Iceberg tables    │
                                         │ DuckDB/PG │   └──────────▲───────────┘    └─────────────────────┘
                                         └─────▲─────┘              │
                                               │         ┌──────────┴───────────────┐
                                               │         │ timelake-maintain (jobs) │
                                               │         │ compaction, caggs,       │
                                               │         │ retention, erasure, idx  │
                                               │         └──────────────────────────┘
         ┌─────────────────────────────────────┴─────────────────────────────────────┐
         │ Readers                                                                   │
         │  • timelake reader (Rust/Python): lake + hot-tier merge, Puffin index     │
         │    pruning, cagg routing, TS functions                                    │
         │  • DuckDB + timelake extension: the same, inside DuckDB                   │
         │  • Plain DuckDB / Spark / Trino: committed Iceberg data                   │
         └───────────────────────────────────────────────────────────────────────────┘
```

*Not drawn:* the **catalog** (`timelake-catalog` or third-party). Every commit and every reader's table lookup goes through it.

### Components (all Rust)
| Component | Form | Responsibility |
|-----------|------|----------------|
| `timelake-core` | library | Table conventions, writer (sorting, partitioning, file sizing), commit protocol, Puffin indexes, hot-tier trait |
| `timelake-catalog` | library + optional service | Iceberg REST catalog with commit queueing, metadata cache, scan planning, commit events (§5.2) |
| `timelake-functions` | library | Engine-agnostic time-series kernels on Arrow (§5.3) |
| `timelake-query` | library | DataFusion integration: table provider, UDF adapters, cagg query rewrite, hot-tier merge, fast paths |
| `timelake-ingest` | binary / container | Firehose-style ingestion with in-stream rules (§13) |
| `timelake-maintain` | binary / job | Compaction, cagg refresh, retention, snapshot expiry. Runs as cron, k8s CronJob, Lambda, or on commit events |
| `timelake` CLI | binary | Create/adopt tables, backfill, query, inspect, erase, run maintenance |
| `timelake` Python | PyO3 wheel | Query → Arrow / Polars / pandas; write; cagg management |
| DuckDB extension | loadable extension | Primary user-facing SQL path: Timelake-aware scans (indexes, hot tier, dedup) and the function library in DuckDB |

---

## 7. Data model and table layout (IoT-first)

### 7.1 Timelake tables: a hypertable-like contract (D5)
Users define their own schema, as with TimescaleDB hypertables. A table becomes a **Timelake table** when it meets this contract:

| Element | Required? | Meaning |
|---------|-----------|---------|
| `time_column` | **Required**, exactly one | `timestamp` / `timestamptz` (µs; ns on Iceberg v3). Drives partitioning, retention, caggs, late-data detection. |
| `series_key` | Optional (strongly recommended) | One or more columns identifying a series, e.g. `(device_id, metric)`. Similar to Timescale's `segmentby` or Influx tags. Drives sort order, dedup, series indexes, bucket partitioning. If absent, the table is treated as a single stream (e.g. an event log). |
| `dedup_key` | Optional | Defaults to `series_key + time_column`. Set to none to disable dedup. |
| `chunk_interval` | Optional | Time partition granularity (like Timescale's `chunk_time_interval`). Auto-chosen from expected volume if omitted. |
| `_ingest_ts` | Added automatically (opt-out) | Arrival time. Powers late-data detection, last-write-wins dedup, and freshness metrics. |
| All other columns | Free-form | Any Iceberg type, including `variant` on v3. Evolves via Iceberg schema evolution (add / rename / widen / drop). |

**Creating a table:**
```sql
CREATE TABLE iot.sensor (
  device_id STRING, metric STRING, ts TIMESTAMPTZ,
  value DOUBLE, quality SMALLINT
) WITH (time_column = 'ts', series_key = ('device_id', 'metric'), chunk_interval = '1 day');
```
```python
lake.create_table("iot.sensor", schema=arrow_schema,
                  time_column="ts", series_key=["device_id", "metric"])
```

**Adopting existing tables:** `timelake adopt <table>` turns an existing Iceberg table (e.g. one in S3 Tables) into a Timelake table, like Timescale's `create_hypertable` on an existing table. It validates the contract, sets `timelake.*` properties, and lets compaction gradually re-lay out the data. This is the main migration path from "S3 Tables + Glue".

**Internal series ID:** Timelake computes a stable 64-bit hash of `series_key` for indexing and bucketing. *Open question Q4: whether to materialize it as a hidden `_series_id` column (faster bucketing and pruning) or keep it only in indexes (cleaner schema for plain-DuckDB users).*

### 7.2 Documented schema templates (not mandatory)
| Template | Example schema | Best for |
|----------|----------------|----------|
| **Narrow** | `device_id, metric, ts, value, quality` | Heterogeneous devices, thousands of metric types, sparse data |
| **Wide** | `device_id, ts, temp, pressure, rpm, …` | Homogeneous fleets, metrics sampled together |
| **Event** | `device_id, ts, event_type, payload (variant/JSON)` | Alarms, state changes, logs |
| **Series metadata** (dimension) | `device_id, site, asset_type, unit, firmware, …` | Tags kept out of the hot table and joined at query time |

IoT tip: include a `quality` column (OPC-UA-style good/uncertain/bad flag). It is common in industrial data and supported by the function library.

### 7.3 Physical layout defaults (derived from the contract; all overridable)
- **Partitioning:** `<chunk_interval>(time_column)` plus optional `bucket(N, series_id)` or `identity(tenant)`, chosen automatically from expected volume.
- **Tiered partition granularity:** Recent data is partitioned by `hour(ts)`. After compaction, older data moves to `day(ts)` or `month(ts)`. This uses Iceberg partition evolution plus a rewrite.
- **Sort order:** `(series_key…, time_column)` within each file. This gives excellent compression (delta-encoded timestamps, similar adjacent values) and tight row-group statistics for series pruning.
- **File sizing:** Target 128–512 MB files with row groups sized for selective reads. Tunable per table.
- **Encodings:** Parquet `DELTA_BINARY_PACKED` for timestamps and integers, `BYTE_STREAM_SPLIT` for floats, and ZSTD.

---

## 8. Write path, freshness, and the hot tier (R4, R13, R15)

### 8.1 Ingestion modes
- **Continuous:** Records stream into `timelake-ingest` or the Rust/Python writer. They are buffered and committed to Iceberg every *T* seconds or *S* MB (defaults: 60 s / 128 MB).
- **Batch / backfill:** Bulk loads of historical data go through the backfill path (§8.4).
- **Idempotency:** Each batch carries an ID that is recorded in the snapshot summary, so retried commits are no-ops.

### 8.2 Freshness tiers (users choose; the default will be decided by profiling B vs. C — Q5)

| Mode | Extra infra | Freshness (Timelake reader) | Freshness (plain DuckDB) | Notes |
|------|-------------|-----------------------------|--------------------------|-------|
| **A. Lake-only** | none | commit interval (~1 min) | commit interval | Simplest and cheapest. No moving parts. |
| **B. Object-store WAL** | none (uses the same bucket) | ~1 s | commit interval | Arrow IPC segments appended to object storage, coordinated with conditional writes (S3 `If-None-Match`/`If-Match`; GCS/Azure preconditions). Optionally on S3 Express One Zone for lower latency. Still serverless. |
| **C. Managed hot store** | Valkey/Redis, Postgres, or DuckDB | sub-second | commit interval* | Also serves a "latest value per series" cache and sub-ms point lookups. |

\*Plain DuckDB can see hot data via a generated view that unions the Iceberg scan with the hot store (e.g. DuckDB's Postgres scanner), or via the future Timelake DuckDB extension.

### 8.3 Lake/hot-tier consistency
- Each lake commit records the **WAL high-water mark** (per ingest partition) in its snapshot summary.
- A Timelake reader reads a snapshot and then reads from the hot tier only *after* that mark. This avoids gaps and double counting, with no coordination service.
- The hot tier is a **cache of uncommitted and recent data**, never the source of truth. It can be wiped and rebuilt from the WAL or the lake.
- The hot tier is accessed through a `HotStore` trait so backends are pluggable (R4).

### 8.4 Backfill (R16, D9)

Backfill means loading historical data (months to years) into a table, usually *while live ingestion continues*. Common IoT cases:
- Onboarding a site that already has a historian (PI, Ignition, …)
- Migrating from TimescaleDB, InfluxDB, or S3 Tables + Glue
- An edge gateway flushing days of buffered data after an outage
- Reprocessing a range after a calibration fix

**Goals:**
- One command.
- No small files.
- No disruption to live ingestion or queries.
- All-or-nothing visibility.
- Resumable.
- Caggs correct afterwards.
- No false alarms.

**How it works**
1. **Plan:** Read the source and map its columns onto the table contract (time column, series key, types, time zone). Split the work into units of *time chunk × series bucket*.
   - `--dry-run` reports row count, time range, overlap with existing data, rows that fall outside retention, and estimated cost.
2. **Write in the final layout:** Workers write files that are already sorted, sized, and partitioned at the granularity appropriate for the data's age.
   - This bypasses the WAL, the hot tier, and later compaction, so nothing gets written twice.
   - Work units are independent, so the job fans out across threads, processes, or Lambdas.
3. **Stage on an Iceberg branch** (`backfill/<job_id>`), the write-audit-publish pattern. Readers of `main` see nothing yet.
4. **Validate:** Row counts vs. the source, dedup-key conflicts, time bounds, null checks, and optional user SQL assertions.
5. **Publish:** Apply the branch's changes onto the current `main` in one atomic commit.
   - Live ingestion keeps committing meanwhile; append-only commits don't conflict.
   - Very large jobs can publish chunk by chunk (e.g. one month at a time) instead.
6. **Follow-up:** The published time ranges are marked as changed, so the caggs over those ranges are refreshed in bulk, in parallel by chunk.

**Overlap modes** (what happens when backfilled rows meet existing rows)

| Mode | Behavior | Typical use |
|------|----------|-------------|
| `merge` (default) | Dedup by `dedup_key`. Conflicts are resolved at write time. By default **existing rows win** (`prefer = existing`); override per job with `prefer = backfill`. | Migrations, gateway catch-up |
| `replace` | Atomically replaces the covered (series, time range) in one commit. Replaced rows are *logically* deleted (§9.2), so it is reversible. | Reprocessing after calibration fixes |
| `fill_gaps` | Inserts only into (series, time range) spans that have no existing data | Patching outages from a secondary source |
| `append` | No overlap checks (fastest) | Loading into an empty table |

**Interactions with the rest of the system**
- **Rules and alarms:** Not evaluated by default.
  - `--evaluate-rules` runs them in historical mode. Resulting events are written with `source = 'backfill'` and are never sent to real-time sinks.
- **Retention:** Rows older than the table's retention are rejected in the dry run unless the job overrides retention.
- **Compaction:** Backfilled files are already compacted. The compactor skips partitions with an unpublished backfill on the same range.
- **Late bulk data from live sources:**
  - **v1:** Manual and opt-in. Users run a backfill for a gateway's buffered data, or mark an ingest stream / batch as `backfill`.
  - **Later:** `timelake-ingest` automatically routes large batches older than a threshold to the backfill writer, avoiding WAL floods and small files in old partitions.
- **Resumable and idempotent:** Job state (units done or pending) is stored in the catalog or object storage. Each work unit has an ID, so `timelake backfill resume <job>` is safe to re-run.

**Sources:** Any source supported by import (§8.5).

**Interfaces:**
```bash
timelake backfill iot.sensor \
  --from 's3://old-historian/export/*.parquet' \
  --map ts=timestamp,device_id=tag_name --tz Europe/Berlin \
  --mode merge --dry-run
timelake backfill status <job>      # progress, throughput, ETA
timelake backfill resume <job>
```
```python
job = lake.table("iot.sensor").backfill(source=df, mode="replace",
                                         start="2024-01-01", end="2025-01-01")
job.wait(); print(job.report())
```
```sql
-- DuckDB extension
CALL timelake_backfill('iot.sensor',
  'SELECT * FROM read_csv(''s3://exports/*.csv'')', mode := 'merge');
```

### 8.5 Import and migration (R18, D10)

**`import` = create (or adopt) a table + backfill.**
- `backfill` loads into a table that already exists.
- `import` also *infers the table contract* from the source and creates the table. It then reuses the backfill engine (§8.4), so all its guarantees apply: final layout, branch staging, atomic publish, resumable, dry run.

**The simple path**
```bash
timelake import readings.csv --table iot.sensor
```
1. **Inspect:** Sample the source and infer column types, timestamp formats, and time zones.
2. **Propose a contract:**
   - Time column: from the type and column name (`ts`, `time`, `timestamp`, …).
   - Series key: low-cardinality string/int columns that repeat across timestamps.
   - Chunk interval: from data volume and time span.
3. **Show the proposal and an import plan:** row estimate, time range, target layout, and cost.
4. **Confirm**, or pass `--yes` for scripts. Edits can be made inline with flags.
5. **Save** the plan as `import.yaml`. It can be edited, version-controlled, and re-run (`timelake import --plan import.yaml`).

**Sources and their smart defaults**

| Source | How it's read | What gets auto-mapped |
|--------|---------------|-----------------------|
| **CSV / TSV** (local, URLs, object-store globs; gzip/zstd) | Streaming parser, parallel by file and byte range | Header → columns; timestamp format and time-zone detection; optional **unpivot** of wide historian exports (one column per tag → `tag, ts, value`) |
| Parquet, JSON/NDJSON, Arrow IPC | Native readers | Schema as-is |
| **Register in place** (Parquet already in the target layout) | No copy (Iceberg `add_files`) | Validated against the contract |
| **Iceberg tables** (S3 Tables, Glue, any REST catalog) | `iceberg-rust` | Schema, partitioning. Two options: copy + re-layout with `import`, or **in place** with `adopt` (§7.1) |
| Delta Lake, DuckLake, Hive-partitioned Parquet | Native or DuckDB-backed reader | Schema, partition columns |
| **TimescaleDB** | Parallel by **hypertable chunk** (natural time-range units), consistent snapshot, binary `COPY` → Arrow | Hypertable time dimension → `time_column`; compression `segmentby` → `series_key`; `chunk_time_interval` → `chunk_interval`; retention policy → retention. Cagg definitions are **translated to Timelake caggs** where the functions map; anything unmapped is reported. |
| PostgreSQL / MySQL / SQL Server | Parallel by time-range slices, ADBC / `COPY` | Time column from type; series key proposed |
| InfluxDB (v1/v2 export, v3 Flight SQL) | Per measurement | Measurement → table; tags → `series_key`; fields → columns |
| ClickHouse, QuestDB | Native protocol or HTTP/Arrow | Time and ordering key → contract |
| Prometheus | Remote-read API | Metric + labels → `series_key` |
| Industrial historians* (AVEVA PI, Ignition SQL historian, …) | **Premium** connectors (§20); CSV exports work in open source | Tag → series, quality → `quality` |
| Anything DuckDB can read | A DuckDB SQL query as the source | Inferred from result schema |

\*A **historian** is the specialized time-series database that factories and utilities run on-site to record sensor and PLC (programmable logic controller) data. Examples: AVEVA PI (formerly OSIsoft PI), Ignition, Honeywell PHD, AspenTech IP.21. In industrial IoT, historians are the most common source of years of historical data, often exported as CSV.

**Migration with cutover (database sources):**
```bash
timelake import postgres://user@host/factory --hypertable public.sensor_data --table iot.sensor_data
timelake import postgres://user@host/factory --all-hypertables --namespace factory
timelake import ... --sync      # keep tailing new rows by time watermark until cutover
timelake import ... --cutover   # final catch-up, then stop
```
1. A bulk historical copy (parallel, resumable).
2. `--sync` keeps copying rows newer than the last watermark, so the source can stay live during migration. Late updates to old rows on the source are caught by a final range re-check before cutover.
3. Logical-replication CDC (exact row-level changes) is a later enhancement.

**Python:**
```python
lake.import_csv("s3://exports/*.csv", table="iot.sensor", time_column="ts")   # or omit for inference
lake.import_from("postgres://…/factory", hypertable="public.sensor_data", table="iot.sensor_data")
```

**Implementation note:**
- Priority sources get native Rust readers: CSV, Parquet, Iceberg, Postgres/TimescaleDB.
- The long tail goes through an optional DuckDB-backed source (DuckDB's scanners for MySQL, SQLite, Delta, Excel, …). It is an optional CLI feature, so the core keeps no C++ dependency (D3).

---

## 9. Late-arriving data, dedup, and deletes

### 9.1 Late and out-of-order data, dedup

- **Late data is normal**, not an error. It is written to its correct time partition. Each commit records the **time ranges it touched** (per partition, optionally per series bucket) in the snapshot summary.
- **Small-file control:** Late data scattered across old partitions creates small files. The compactor prioritizes partitions by *small-file count × query heat*.
- **Cagg invalidation:** The cagg refresher diffs snapshots since its last processed snapshot and recomputes only the affected buckets (§11). No separate change log is needed.
- **Duplicates and corrections:** IoT devices resend data. Per-table policy:
  - `append` (default for raw): Duplicates are removed at compaction and at read time by the Timelake reader, using `dedup_key` and keeping the latest `_ingest_ts`.
  - `upsert`: Same as `append`, but exposed as a first-class semantic for corrections.
- **Trade-off:** Plain DuckDB may see duplicates in recently written, not-yet-compacted partitions. The Timelake DuckDB extension removes them on read. *Open question Q3.*

### 9.2 Deletes: immutable by design (D6)

**Principle:** A delete never mutates or destroys existing data. It is a new, audited, immutable fact layered on top. Iceberg already works this way: data files are never modified, and deletes are recorded as *new* delete files / deletion vectors in a new snapshot.

| Operation | Mechanism | Visible to plain DuckDB? | Reversible? |
|-----------|-----------|--------------------------|-------------|
| **Logical delete** (default) | Predicate → Iceberg v3 deletion vectors (v2: position deletes). Never rewrites data files. | Yes (if the engine supports the delete-file type; *verify DuckDB v3 DV support*) | **Yes**: `UNDELETE <delete_id>` commits a snapshot that removes those delete vectors. Original rows were never touched. |
| **Retention drop** | Whole-partition removal by policy | Yes | Until the snapshot expires |
| **Purge** (hard delete, for compliance) | Explicit, privileged operation: rewrites affected files without the rows, expires snapshots that still reference them, removes orphans | Yes | **No**, by design. Requires a reason and is audited. |

**Time-series-shaped deletes are first-class:**
```sql
DELETE FROM iot.sensor
WHERE device_id = 'pump-7' AND ts BETWEEN '2026-10-01' AND '2026-10-02'
WITH (reason = 'sensor miscalibrated', ticket = 'OPS-123');
```

**Audit trail:**
- Every delete gets a `delete_id` and records actor, timestamp, predicate, reason, and affected row count.
- These records go in the snapshot summary **and** in an append-only `_timelake_audit` Iceberg table, so audits are a SQL query.

**Consistency with caggs:** A delete, undelete, or purge marks its time ranges as changed, so the affected cagg buckets are recomputed (§11). Rollups never silently include deleted data.

**Corrections vs. deletes:** Bad values usually need *correcting* rather than deleting. An `upsert` writes the corrected row, and dedup keeps the latest `_ingest_ts`. The original stays in older snapshots, so history is preserved without a delete.

### 9.3 GDPR erasure (R17, D8)

A logical delete hides data but is not erasure: the bytes still exist in the original files and older snapshots. GDPR requires physical removal from **every copy**.

**Identifying the data subject.** In IoT, personal data is usually *indirect*: a person is linked to a vehicle, wearable, smart meter, or badge, not to individual rows. Tables can therefore declare a `subject_key`:
- **Direct:** a column on the table itself, e.g. `user_id`.
- **Indirect:** a mapping through a dimension table, e.g. `devices.owner_id`. Erasing a person resolves to "these series, over these time ranges of ownership."

**Erasure workflow**
1. **Request:** `timelake erase --subject <id>` (or an explicit predicate) creates an erasure request with an ID and a deadline.
2. **Immediately:** A logical delete is applied across every affected table, and the hot tier is evicted. The data is invisible within seconds.
3. **Physical purge** rewrites files, which is the expensive part, so it is *batched* by default:
   - `purge_schedule = daily` (default): All erasure requests from the day are purged together in the next maintenance run, so a file shared by several requests is rewritten once.
   - `timelake erase … --now`: Purge immediately. This takes minutes; duration scales with the amount of data touched, not the table size.
   - `max_purge_delay` (default 7 days): A hard upper bound. If a purge hasn't completed by then (e.g. jobs failing), Timelake alerts. GDPR expects erasure "without undue delay", generally within one month.
   - The purge job:
     - Rewrites affected files without the rows. The series-sorted layout keeps the number of touched files small.
     - Expires every snapshot that references the old files and deletes the orphaned files.
4. **Verify and certify:** A verification query confirms zero matching rows remain. The request is closed with a record of files rewritten, snapshots expired, and objects deleted.

**Coverage checklist (what purge must reach)**

| Location | Action |
|----------|--------|
| Raw tables, events table | Rewrite files; expire snapshots; delete orphans |
| Caggs | Recompute affected buckets; delete per-subject rollup rows (aggregates across many subjects are generally not personal data) |
| Hot tier | Delete/rewrite WAL segments; evict Valkey/DB keys |
| Puffin indexes, bloom filters, sketches | Rebuild for rewritten files |
| Catalog and reader caches | Invalidate; local caches have a bounded TTL |
| Ingest state checkpoints | Remove per-series state |
| **Bucket versioning / replication** | Purge must also delete non-current object versions and replicas, or the job fails loudly. |
| User backups outside Timelake | Out of scope; documented |

**Audit without leaking personal data:** Erasure audit records store the request ID and a *salted hash* of the subject identifier, never the raw identifier or predicate values. (Ordinary logical-delete audits, §9.2, store the predicate as-is.)

**Time-travel trade-off:** Erasure shortens time travel for affected files, because snapshots older than the purge that reference purged files must be expired. This is documented and surfaced in the erasure report.

**Tenant offboarding: crypto-shredding (optional):**
- With a warehouse or bucket per tenant (§14), each tenant can have its own KMS encryption key.
- Destroying that key makes all of the tenant's data unreadable instantly, followed by asynchronous deletion of the objects.
- This doesn't work for individual subjects inside a shared table; those use the purge workflow above.

**Legal hold / WORM:** Not in v1 (Q11 resolved). Purge must always be possible for GDPR. Per-table legal hold may come later, with explicit rules for how it interacts with erasure requests.

---

## 10. Table maintenance: the "Glue jobs" we replace (R13)

`timelake-maintain` runs as a set of idempotent, independently schedulable tasks:

| Task | What it does |
|------|-------------|
| Compaction | Merges small files, re-sorts by `(series_key…, time_column)`, applies dedup, coarsens partitions for old data |
| Cagg refresh | Incremental, snapshot-diff based (§11) |
| Retention | Per-table TTL (e.g. raw 90 d, 1-min cagg 2 y, 1-h cagg forever). Drops whole partitions (metadata-only when aligned) |
| Snapshot expiry and orphan cleanup | Keeps metadata small and storage costs down |
| Manifest rewrite | Clusters manifests by time so planning stays fast as tables grow |
| Index build | Writes Puffin blobs (series index, last-value index, sketches) |

These tasks can be triggered by a schedule, by commit events (catalog events, S3 notifications), or inline from the writer for small deployments. The core is concurrency-safe via Iceberg optimistic commits and conflict-aware retries.

---

## 11. Continuous aggregates and the function library (R5)

### 11.1 Continuous aggregates (caggs)
- Defined declaratively in SQL:
  ```sql
  CREATE CONTINUOUS AGGREGATE sensor_1m AS
  SELECT device_id, metric,
         time_bucket('1 minute', ts) AS bucket,
         avg(value), min(value), max(value),
         time_weight('linear', ts, value) AS tw,
         count(*)
  FROM iot.sensor
  GROUP BY 1, 2, 3
  WITH (refresh_lag = '2 minutes', retention = '2 years');
  ```
- **Every cagg is itself an Iceberg table**, so DuckDB and others can query rollups directly.
- **Incremental refresh:** Only buckets touched since the last refresh are recomputed (from snapshot diffs). This handles late data correctly.
- **Hierarchical caggs:** 1 min → 1 h → 1 d, each built from the previous level.
- **Real-time aggregation (Timelake reader):** Combines materialized buckets with on-the-fly aggregation of the not-yet-materialized tail and hot-tier data.
- **Automatic query routing:** The Timelake reader rewrites `GROUP BY time_bucket(...)` queries to use the best matching cagg.
- **Mergeable state:** Aggregates that can't be re-merged from final values (percentiles, time-weighted averages) store intermediate **state** (sketches, partial sums), as in TimescaleDB Toolkit's two-step aggregates.

### 11.2 Function library (target parity with TimescaleDB + Toolkit)
| Category | Functions |
|----------|-----------|
| Bucketing | `time_bucket` (with origin, offset, timezone, months), `time_bucket_gapfill` |
| Gap filling | `locf`, `interpolate`, `gapfill` |
| Selection | `first`, `last`, `last_value_before`, ASOF JOIN |
| Statistics | `stats_agg` (mean, stddev, regression…), `histogram` |
| Percentiles | `approx_percentile` (t-digest / UDDSketch), `percentile_agg` |
| Counters | `counter_agg`: `rate`, `delta`, `irate`, reset handling |
| Gauges | `gauge_agg` |
| Time-weighted | `time_weight` (LOCF / linear), `average`, `integral`. **Critical for IoT** because sampling is irregular |
| State / uptime | `state_agg`, `heartbeat_agg` (uptime, downtime, gaps), `duration_in` |
| Finance | `candlestick_agg` (OHLC + volume) |
| Downsampling for viz | `lttb`, `asap_smooth`, `min_max` per pixel |
| Anomaly helpers | rolling z-score, rate-of-change, flatline/stuck detection |

**Availability by engine:**
- **Timelake reader (DataFusion):** Full library as Rust UDFs/UDAFs.
- **Plain DuckDB:** Functions DuckDB has natively (`time_bucket`, `arg_max`, ASOF JOIN, `approx_quantile`) plus a published **SQL macro pack**. The macros must use fixed-width intervals (e.g. `'24 hours'`, not `'1 day'`) or `date_trunc` for UTC data. Calendar-unit buckets on `timestamptz` take a ~130× slower path in DuckDB (measured in §17.5).
- **DuckDB extension (later):** Full parity.

---

## 12. Read path (R1, R10, R14)

### 12.1 Plain DuckDB (zero Timelake software)
```sql
INSTALL iceberg; LOAD iceberg;
ATTACH 'warehouse' AS lake (TYPE iceberg, ENDPOINT 'https://catalog…');
SELECT time_bucket(INTERVAL '1 hour', bucket) AS h, avg(avg_value)
FROM lake.iot.sensor_1m WHERE device_id = 'pump-7' AND bucket > now() - INTERVAL 7 DAY
GROUP BY 1 ORDER BY 1;
```
This path sees committed data only, and does not get hot-tier merge, dedup-on-read, or the full function library.

### 12.2 Timelake reader (Rust + Python): "faster than DuckDB" on time-series shapes
We don't try to beat DuckDB as a general engine. We win by using knowledge a generic engine doesn't have:
1. **Series-level pruning** from Puffin indexes, which goes beyond min/max statistics: open only the files and row groups containing the requested series.
2. **Last-value index:** "Current state of every device" without scanning.
3. **Automatic cagg routing.**
4. **Sort-order awareness:** No re-sorting for per-series windows and ASOF joins.
5. **Hot-tier merge** for instant freshness.
6. **I/O tuned for object storage:** Coalesced range reads, parallel GETs, and a metadata and footer cache (in memory or on local disk).

**Python API sketch:**
```python
import timelake as tl
lake = tl.connect("s3://bucket/warehouse", catalog="rest://…")
tbl = lake.table("iot.sensor")
df = tbl.query(series={"site": "plant-3", "metric": "temp"},
               start="-24h", bucket="5m", agg=["avg", "max"]).to_polars()
lake.sql("SELECT … time_weight(…) …").to_arrow()   # full SQL via DataFusion
tbl.to_duckdb()                                     # hand off an Arrow stream to DuckDB zero-copy
```

---

## 13. Ingestion: `timelake-ingest` (R11, D11)

A Telegraf / Firehose-style pipeline that does **ingestion and in-stream analytics in one place**. It is a **library first**: the same pipeline code runs in every deployment form, and the binary, container, and Lambda handler are thin wrappers around it.

### 13.1 Deployment forms
| Form | Triggered by | Best for |
|------|--------------|----------|
| **Embedded library** (Rust; Python via bindings) | User code calls `pipeline.push(batch)` | Apps that already receive data |
| **AWS Lambda** (and other FaaS) | Kinesis, SQS, IoT Core rules, API Gateway, S3 object-created events, EventBridge schedule | Bursty or low-volume fleets; scale to zero; no ops |
| **Container / microservice** | Long-lived consumers: MQTT, Kafka/Redpanda, NATS, HTTP, Arrow Flight | Steady high volume; persistent MQTT connections |
| **Edge binary** | Same as container, on a gateway | Factories and sites with unreliable uplinks: buffers locally, then catches up |

All forms share a single config file in the spirit of Telegraf's (`inputs → processors → rules → outputs`), so a pipeline can move from Lambda to a container without changes.

### 13.2 Pipeline
- **Inputs:** MQTT (IoT first-class), HTTP (JSON/NDJSON), Arrow Flight / Arrow IPC, Kafka/Redpanda, Kinesis, NATS, InfluxDB line protocol, OTLP metrics. OPC-UA and Sparkplug B are candidates.
- **Stages:** decode → schema validation and evolution → enrichment (join with series metadata) → transforms (DataFusion SQL) → **rules** → buffer → WAL / hot tier → lake commit.

### 13.3 Rules
- **Built-in rules (configurable per series or group):**
  - Threshold and range (with hysteresis)
  - Rate of change / spike
  - Flatline or stuck sensor
  - Missing data / heartbeat timeout
  - Out-of-order or late beyond tolerance
  - Unit and schema anomalies
  - Statistical anomalies (rolling z-score, EWMA)
- **Outputs of rules:** Rows in an **`events` Iceberg table** (queryable history of alarms) plus real-time sinks (webhook, Kafka, SNS/SQS, MQTT topic). Generalized to any event type and any event stream in F3 (§21.3).

### 13.4 Rule state without a server (draft — Q17)
| Rule type | State needed | How it works serverless |
|-----------|--------------|-------------------------|
| Stateless (threshold, range, schema) | None | Runs anywhere, any instance |
| Short windows (rate of change, flatline, z-score, hysteresis) | Small per-series state (last values, running stats) | Affinity via the source's partitioning (Kinesis shard / Kafka partition keyed by series), so one consumer sees a series in order. State is checkpointed with the source offset to object storage or the hot store, and restored on cold start. |
| Absence of data (heartbeat, missing data) | "Last seen" per series | Can't be triggered by data that never arrives. A **scheduled sweep** (e.g. EventBridge every minute, or a timer in the container) checks the last-value index / hot store for overdue series. |

### 13.5 Scaling
- Horizontal.
- Stateless stages scale freely.
- Stateful rules scale with the number of source partitions.
- Containers use consistent hashing on the series key when the source has no partitioning (e.g. MQTT).

---

## 14. Multitenancy (R12)

Documented patterns with trade-offs and examples:
| Pattern | Isolation | Cost / ops | When |
|---------|-----------|-----------|------|
| Shared table, `tenant` partition column | Row-level (enforced by catalog/engine policies) | Cheapest | Many small tenants |
| Namespace per tenant | Catalog-level ACLs | Low | Tens to thousands of tenants |
| Warehouse/bucket per tenant | IAM + per-tenant KMS keys | Higher | Regulated / enterprise tenants |

Plus examples for credential vending via the REST catalog, per-tenant retention and caggs, and per-tenant ingestion quotas.

**Other planned doc recipes:** factory sensor monitoring, fleet/GPS tracking, energy metering (counters → `counter_agg`), building management, observability metrics, crypto/stock ticks, migrating from S3 Tables + Glue, and migrating from TimescaleDB/InfluxDB.

---

## 15. Deployment and cost model (R13)

- **Minimum deployment:** One bucket, one Iceberg catalog, and the Timelake library inside the user's app or one ingest container, plus a scheduled `timelake-maintain`. There is no always-on Timelake server.
- **Catalog options:**
  - **`timelake-catalog`** (recommended), in one of three forms:
    - In-process library (single node / edge)
    - Scale-to-zero function (Lambda / Cloud Run)
    - Container
    Object-storage backend by default; Postgres optional.
  - Bring your own: S3 Tables, Glue, Lakekeeper, Polaris, Nessie, Unity, with the reduced capabilities listed in §5.2.
- **Cost levers:** Fewer, bigger files (lower GET/PUT costs); rollups instead of raw scans; tiered retention; optional cold storage classes for old partitions.

---

## 16. Landscape and positioning (R7)

### 16.1 Table formats

| | Iceberg (plain) | Delta Lake | Apache Hudi | Apache Paimon | DuckLake | Lance | **Timelake** |
|---|---|---|---|---|---|---|---|
| Steward | Apache | Linux Foundation (Databricks) | Apache (Onehouse) | Apache (Alibaba) | DuckDB Labs | LanceDB | — |
| Core idea | Spec-first open table format | Transaction log on object storage | Streaming upserts, record indexes | LSM tree per bucket; streaming-first | Metadata in a SQL database | Random access for ML / vectors | Iceberg + time-series conventions + optional hot tier |
| Read support (DuckDB / Spark / Trino / warehouses) | Broadest | Broad | Spark/Flink-centric | Flink/Spark-centric; can emit Iceberg metadata | DuckDB-centric | Limited for analytics | Same as Iceberg |
| Frequent small writes | Weak (per-commit metadata cost) | Moderate | Good | **Strong** (LSM) | **Strong** (inlining in catalog DB) | Moderate | Strong *with* hot tier / batched commits |
| Upserts / dedup | Merge-on-read deletes | MERGE, deletion vectors | Native | Native (merge engines) | Yes | Yes | Dedup by `dedup_key` (§9.1) |
| Time-series aware layout / compaction | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Rollups (caggs) | ✗ | ✗ | ✗ | Aggregation merge engine (on write) | ✗ | ✗ | ✓ incremental, late-data aware |
| Needs extra infrastructure | Catalog | Optional catalog | Spark/Flink jobs | Flink/Spark jobs | SQL database | ✗ | Catalog (ours or any); hot store optional |

### 16.2 Managed catalogs and maintenance services

| | AWS S3 Tables | Cloudflare R2 Data Catalog | Apache Amoro | Lakekeeper / Polaris / Nessie | **Timelake** |
|---|---|---|---|---|---|
| What it is | Managed Iceberg + table buckets | Managed Iceberg catalog on R2 | Open-source "self-optimizing" lakehouse manager (JVM server) | Open-source Iceberg REST catalogs | Open-source library + optional catalog + jobs |
| Storage | AWS only | R2 only | Any | Any | Any |
| Compaction | Generic, automatic (billed) | Generic, automatic | Generic: compaction, dedup, sort | ✗ | **Time-series aware**, tiered partitions |
| Snapshot expiry / cleanup | ✓ | ✓ | ✓ | ✗ | ✓ |
| Late data, caggs, retention by time, GDPR erasure, backfill, ingestion rules | ✗ | ✗ | ✗ | ✗ | ✓ |
| Runs serverless / scale to zero | Managed | Managed | ✗ (resident server) | Server | ✓ |

**Also watch:** RustFS 1.0 (Apache-2.0, Rust, GA 2026-09) is an S3-compatible object store that ships an **Iceberg REST catalog / S3 Tables-style API**. It's a likely integration target (storage + catalog in one binary) and a potential competitor for the "open-source S3 Tables" position.

### 16.3 Time-series databases (baselines, not lakes)
TimescaleDB, InfluxDB 3, QuestDB, TDengine, GreptimeDB. They are fast and feature-rich, but they own the storage. Long retention is expensive, and the data is not an open table that other engines can read. They are the **performance and ergonomics bar** Timelake is measured against (§17).

**TimescaleDB on Tiger Cloud is the closest managed alternative.**
- **Tiered storage** (`timescaledb_osm`) moves older chunks to S3, and they stay queryable through the database. It has to be enabled per service in the Console; it can't be enabled over SQL.
- **`timescaledb_lake`**, Tiger's Iceberg integration, is available on Tiger Cloud services (seen at version 1.0.1, 2026-10). It is to be evaluated.

Both keep the database as the entry point, which is the trade-off Timelake avoids. The benchmark of tiered storage is in `bench/v0/tsdb_cloud.py`.

*All Timelake columns are design targets until measured by `timelake-bench` (§17).*

---

## 17. Benchmark: `timelake-bench` (R7, R14)

One reproducible suite, run against Timelake **and every alternative** in §16, using each system's idiomatic tooling.

### 17.1 Base workload: TSBS IoT, adopted
We adopt the **TSBS IoT use case** (Timescale's Time Series Benchmark Suite) rather than inventing our own. It is the de-facto TSDB benchmark with an IoT scenario, it has published results for TimescaleDB, InfluxDB, QuestDB, and TDengine, and it already models what IoT data looks like:
- **Scenario:** A fleet of trucks.
  - `readings`: 7 metrics + 8 tags
  - `diagnostics`: 3 metrics + 8 tags
  - Nanosecond timestamps, one record per ~10 s
  - **Includes out-of-order and missing data**
- **Scale:** The number of trucks (we use 1k / 10k / 100k).
- **The 12 IoT queries:**

| TSBS query | Shape it exercises |
|---|---|
| `last-loc` | Last value per series |
| `low-fuel`, `high-load` | Latest-state filter across the fleet |
| `stationary-trucks` | Recent-window aggregate per series |
| `long-driving-sessions`, `long-daily-sessions` | Session/state analysis over a window (≈ `state_agg`) |
| `avg-vs-projected-fuel-consumption`, `avg-load` | Group-by aggregate over tags |
| `avg-daily-driving-duration`, `avg-daily-driving-session` | Daily bucketing + sessions |
| `daily-activity` | Uptime/downtime per day (≈ `heartbeat_agg`) |
| `breakdown-frequency` | Event detection over history |

**Data generation:** Use the TSBS generator (`tsbs_generate_data --use-case=iot`), then convert it once to Parquet as the common input for every system. This keeps results comparable with published TSBS numbers.

### 17.2 Lake extensions (what TSBS doesn't cover)
TSBS assumes a database. A lake also has to be judged on these, borrowing ideas from IoTDB-Benchmark and TPCx-IoT (out-of-order ingestion, downsampling):

| Workload | Measures |
|---|---|
| **Streaming ingest** in small batches (1 s / 10 s / 60 s) | Throughput; **freshness** (write → visible to a query); files and metadata created per hour |
| **Bulk load / backfill** of 1 year | Time, cost, final file count, behavior under concurrent live ingest |
| **Late data** at 1% / 10% / 30%, up to 30 days late | Query correctness, small-file growth, cagg correctness after refresh |
| **Maintenance** | Compaction time/cost; query speed before vs. after; snapshot/metadata size over 30 days of commits |
| **Rollups** | Cagg refresh cost; TSBS daily queries answered from caggs vs. raw |
| **Deletes** | Logical delete (device + range) latency; GDPR purge time and bytes rewritten |
| **Extra query shapes** | Time-weighted average with irregular sampling; gap-filled `time_bucket`; ASOF join of two series; raw range read for 1 / 100 series over 1 h / 1 d / 30 d |
| **Storage** | Bytes on disk per raw row (compression), object count |

### 17.3 Systems under test
| Category | Systems | Writer / engine used |
|---|---|---|
| Timelake | Lake-only, object-store WAL, Valkey hot store (Q5) | Timelake writer; Timelake reader **and** plain DuckDB |
| Plain Iceberg | Iceberg + REST catalog | PyIceberg / Spark write; DuckDB, Trino read |
| Managed Iceberg | S3 Tables; R2 Data Catalog | Spark/PyIceberg write; Athena / DuckDB read |
| Other formats | Delta Lake, Hudi, Paimon, DuckLake, Lance | delta-rs, Spark, Flink, DuckDB, lance |
| TSDB baselines | TimescaleDB, InfluxDB 3, QuestDB | Their native TSBS loaders |

### 17.4 Methodology
- **Same hardware and same object store** for every lake system:
  - Locally: RustFS (or SeaweedFS), with injected latency (e.g. toxiproxy) to approximate S3's per-request latency.
  - Published runs: real S3 in-region, plus S3 Express One Zone and R2. Local object stores don't reproduce S3's request latency, so they are for repeatability only. MinIO's community edition is no longer maintained.
- **Object-store compatibility matrix (CI):** S3, GCS, Azure Blob, R2, RustFS, SeaweedFS, Garage. Each is tested for the features Timelake relies on, especially **conditional writes** (`If-None-Match` / `If-Match`), which the object-store-only catalog and WAL require (§5.2, §8.2).
- **Cold and warm runs reported separately:** cold means no local caches.
- **Results include:** p50/p99 latency, bytes read, **object-store request counts**, and **estimated $** (per query, per GB ingested, per month of storage).
- **Configurations:** Every system's configuration and version is committed. Each system is tuned per its own docs, and vendors are invited to review.
- **Harness:** `bench/` with a driver, one adapter per system, and generator + converter scripts. One command reproduces a run (`timelake-bench run --system X --scale 10k`).

### 17.5 Phase 0 baseline (2026-10-11)
Full results: [`bench/results/BASELINE.md`](bench/results/BASELINE.md).
- **Coverage:** TSBS IoT (500 trucks × 3 days), TPC-H SF10, and ClickBench (10% subset), on DuckDB, DataFusion, Polars, DuckDB over Iceberg, and TimescaleDB. Local disk, M1 Pro.
- **No engine dominates.** Polars won TSBS and TPC-H, DataFusion won ClickBench, and DuckDB was close behind on all three. DataFusion is weakest on join-heavy TPC-H, which is not Timelake's workload.
- **TimescaleDB vs. lake:**
  - TimescaleDB is **~100× faster on last-value lookups** (2–3 ms vs. 34–317 ms). → The last-value index / hot store is mandatory.
  - The lake engines are **4–44× faster on analytics** and use **14× less storage** (vs. *uncompressed* TimescaleDB).
- **Sorted, day-partitioned Iceberg beat unsorted Parquet** in DuckDB (`last-loc` 2× faster). This validates time-aware layout and compaction.
- **DuckDB pitfall:** `time_bucket(INTERVAL '1 day', timestamptz)` is ~130× slower than `INTERVAL '24 hours'` (§11.2).
- **Object storage (RustFS + 20 ms per request, [`OBJECT_STORAGE.md`](bench/results/OBJECT_STORAGE.md)):**
  - First runs are 2.7–6.4× slower than local disk.
  - Repeat speed depends on in-process caching: DuckDB caches, DataFusion/Polars don't. → The reader cache is a priority.
  - Iceberg metadata adds round trips. → Catalog-side planning matters.
  - The latest-value query downloads ~165 MB.
- **Parquet vs Vortex ([`VORTEX.md`](bench/results/VORTEX.md)):** Vortex is faster locally (2.4–4× on single-device queries), at parity to slower on object storage (more requests), and not smaller in our layout. → D16.
- **DataFusion (Rust) vs DuckDB on object storage:** DataFusion was faster on first runs (TSBS 0.29 s vs 0.35 s; single-device 0.12 s vs 0.22 s) but slower on repeats (DuckDB caches file data). → D3 plus a Timelake data cache.
- **Parquet filter pushdown** in DataFusion is 1.2–1.6× *slower* on object storage (extra range requests) and slightly faster locally. Enable it per query shape.

### 17.6 IIoT benchmark (planned)
TSBS models a truck fleet at ~10 s per device. Industrial plants look different, and that is the market (Polythings' IIoT platform). The IIoT benchmark lives in `bench/iiot` and runs next to TSBS, not instead of it.

**Principles**
- **Every opponent, one table.** Timelake, InfluxDB 3 Core, TimescaleDB, ClickHouse, QuestDB, naive Iceberg (the S3 Tables write pattern) and Lance.
- **Honest, including where we lose.** Timelake is a lakehouse, not a database. A database on local disk answers point lookups in milliseconds, handles many concurrent dashboards and shows data within a second; Timelake doesn't (yet; a cache layer may close part of the gap). We publish those losses next to the wins.
- **Always in context of cost and scale.** Each result sits next to what it costs per month on AWS (compute + storage + requests) and how it changes as data grows. Readers need statements of the form "system X answers in N ms on an instance costing $A/month; Timelake answers in M ms for $B/month of S3", with measured numbers.
- **Reproducible and reviewable.** Generator seeds, configs and versions are committed; each system is tuned per its own docs; vendors are invited to review.

**Data.** A deterministic Rust generator replays plant behavior faster than real time:
| Workload | Shape |
|---|---|
| Process historian | 100k+ tags, narrow rows (tag, time, value, quality), mixed rates: 1 s, 10 s, 60 s and change-of-value |
| Condition monitoring | Vibration bursts at 1–10 kHz from hundreds of machines, uploaded in 1–10 s blocks |
| Store-and-forward | Gateways offline 1–12 h, then backfill out of order while live data continues; 1–2% duplicates (at-least-once delivery) |
| Meters and fleets | Millions of slow series arriving as periodic batch files (cardinality stress) |

**Scale tiers** by raw ingest rate (uncompressed row bytes): **10 MB/h, 100 MB/h, 1 GB/h, 10 GB/h**. Each tier runs long enough to hold 1 day, 7 days and 30 days of data, and queries are measured at each checkpoint, so every chart shows the trend as data grows.

**Queries** an operator, engineer or report actually runs, all while ingest continues: dashboard refresh (latest value of 1,000 tags; last 15 min of 20 tags), 30-day trend downsampled to ~1,000 points, hourly shift report per asset joined with asset metadata, raw window around an alarm (50 tags, ±10 min), time above a limit, time-weighted average, energy from cumulative counters, and a concurrency run (N dashboards refreshing at once).

**Measured for every system and tier**
- Query latency p50/p95, cold and warm, under ingest; concurrent throughput.
- Freshness: arrival → queryable.
- Sustained ingest rate and the smallest setup that keeps up.
- Maintenance work: CPU time, bytes rewritten, extra services or jobs to run.
- Storage: bytes and object count.
- **$ per month on AWS:** instance hours (or Lambda time) for each system's servers or writers, plus S3 storage and requests by type (GET, PUT, LIST, DELETE, counted by `bench/tools/s3proxy`), plus managed fees where they apply (S3 Tables compaction).
- Where each system keeps data: local disk, EBS, object storage, or a mix (ClickHouse on S3 disks, QuestDB and TimescaleDB on local disk, InfluxDB 3 Core on object storage). Results say so next to every number.

---

## 18. Open questions

| # | Question | Current leaning |
|---|----------|-----------------|
| Q1 | Iceberg v2 or v3 as the minimum? v3 brings `timestamp_ns`, variant, and deletion vectors (needed for D6), but reader support varies. | **Research:** track v3 read/write support in DuckDB, Spark, Trino, Athena, Snowflake, PyIceberg, and `iceberg-rust`. If it is broad and stable by Phase 1, go v3-only and skip v2. |
| Q2 | `timelake-catalog`: extend/fork Lakekeeper or build on `iceberg-rust`? | Evaluate in Phase 0 |
| Q3 | Should plain-DuckDB readers ever see duplicates or uncompacted late data? | Accept briefly; the DuckDB extension removes them; aggressive compaction of recent partitions |
| Q4 | Materialize a hidden `_series_id` column or keep it index-only? | Decide after benchmarks |
| Q5 | Default hot tier: object-store WAL (B) or Valkey (C)? | **Profile both** (latency, cost per GB, ops burden) before choosing |
| Q6 | Where does the cagg definition live: table properties, or the catalog? | Catalog when `timelake-catalog` is used, mirrored into table properties for portability |
| Q7 | ~~How mature is `iceberg-rust` for writes?~~ | **Answered (spike 1), and the v0 commit layer is implemented on its public types (D13):** append + read are solid and DuckDB-compatible on v2 and v3. Replace, row-delta, delete writers, branch commits, manifest merging, and file cleanup are missing and not extensible from outside the crate. → D13. Details: `spikes/iceberg-write/README.md` |
| Q8 | Vortex: when Iceberg adds pluggable file formats, how do we migrate (compaction rewrites to Vortex)? | Keep a file-format abstraction in `timelake-core` from day one. **Measured (2026-10-11, `bench/results/VORTEX.md`), via DuckDB and via DataFusion + `vortex-datafusion` (Rust):**
- Local disk: Vortex is 20–45% faster, and 2.4–4× faster on single-device queries.
- Object storage: Vortex is at parity to 1.5× slower with DataFusion, because it issues more requests; with DuckDB, 1.3–3× slower (that extension doesn't cache).
- Size: Vortex files are *larger* in our sorted layout.
→ D16 |
| Q9 | ~~License~~ | **Resolved:** Apache 2.0 (D7) |
| Q10 | Rule engine scope: a SQL-defined rules DSL, or YAML presets plus SQL escape hatch? | YAML presets + SQL |
| Q11 | ~~Legal hold / WORM?~~ | **Resolved:** not in v1; GDPR purge must always be possible (D8) |
| Q12 | DataFusion vs. embedded DuckDB as the internal engine (D3) | DataFusion, pending the Phase 0 spike. The spike runs the TSBS IoT queries (§17.1) on our Parquet layout in DataFusion, DuckDB, and Polars, since general benchmarks disagree and depend on the harness. Polars is evaluated as a reference, not as a candidate engine: its Rust API is secondary and it lacks DataFusion's extension points. |
| Q13 | ~~GDPR purge timing defaults~~ | **Resolved:** daily batched purge; `--now` for immediate; alert if `max_purge_delay` (7 days) is exceeded |
| Q14 | ~~Backfill conflict default~~ | **Resolved:** existing rows win; `prefer = backfill` override per job |
| Q15 | ~~Auto-routing late bulk data to backfill~~ | **Resolved for v1:** manual opt-in only; automatic routing later (threshold tuned by benchmarks) |
| Q17 | Rule state on Lambda: object-store checkpoints vs. hot store; sweep cadence for heartbeat rules | Prototype in Phase 6 |
| Q18 | F1: are agent permission sets open source or premium (§20)? Policy file format: our own JSON, or an existing one (Cedar, OPA/Rego)? | Open source enforcement in the reader; our own small JSON format first |
| Q19 | F2: tile format (Arrow IPC, Parquet, or JSON) and tile sizes per resolution; how much regeneration a commit may trigger | Arrow IPC (fastest in `timelake-wasm`), sizes chosen by benchmark; debounce per model |
| Q20 | F3: is the commit-driven trigger an object-store notification (S3 events), a catalog event, or a poll of the newest snapshot? | Support all three; poll as the portable fallback |
| Q21 | F4: how to run user Python safely in a hosted service | Out of scope until F4; the self-hosted version runs in the user's own process |
| Q16 | ~~Which import sources ship first?~~ | **Resolved:** Phase 1: CSV, Parquet, Iceberg/S3 Tables. Phase 2: TimescaleDB/Postgres with `--sync` cutover. Then InfluxDB, others via the DuckDB-backed source. Historian connectors are premium (D12) |

---

## 19. Roadmap (draft)

### 19.0 v0: a faster, maintenance-free time-series table on S3 (in progress)
**Value proposition.** "Better than naive S3 Tables or Lance for time series, with no Glue jobs." A team that today appends micro-batches to S3 Tables (Firehose, PyIceberg, Spark) and reads with DuckDB/Athena should get, by switching to Timelake v0:
- the same open Iceberg tables (plain DuckDB still reads them),
- on any object store (S3, R2, GCS, Azure, RustFS/MinIO, local disk),
- with time-series layout and maintenance built in (sort, compaction, dedup, retention, snapshot expiry), run inline by the writer or as one stateless `timelake maintain` command,
- and much faster time-series reads through the Timelake reader, including a last-value index.

**In scope (v0):**
| Area | v0 deliverable |
|------|----------------|
| Catalog | Object-store-only catalog: `vN.metadata.json` committed with put-if-absent (conditional write), `version-hint.text` for Hadoop-style readers (DuckDB `iceberg_scan`). No server. |
| Contract | `time_column`, `series_key`, `chunk_interval` (hour/day/month), dedup on/off, retention, all as `timelake.*` table properties. Tables without a time column (dimensions, e.g. device metadata) are allowed. |
| Writer | Append Arrow batches → align to table schema → sort by `(series_key…, time)` → split by time partition → Parquet (ZSTD, page index, time-series encodings). Idempotent batch IDs. |
| Commit layer (D13) | Own append / replace / delete commits on iceberg-rust public types, manifest merging, optimistic retry. Iceberg v2 by default. |
| Last-value index | A small Parquet sidecar per snapshot with the latest row per series (pointer in the snapshot summary). Updated on every append. |
| Maintenance | Compaction (merge, re-sort, dedup, latest write wins), retention (drop expired partitions), snapshot expiry + unreferenced-file cleanup. Inline auto-maintenance after appends (thresholds) or `timelake maintain`. |
| Reader | DataFusion `TableProvider`: file pruning on Iceberg column bounds, Parquet row-group/page pruning, `time_bucket`, and automatic rewrite of latest-row queries (`ROW_NUMBER() … = 1`, `ORDER BY time DESC LIMIT 1`) onto the last-value index. |
| Interfaces | `timelake` CLI (create, append/import Parquet+CSV, sql, latest, maintain, info, duckdb) and a Python package (PyO3): `Lake`, `create_table`, `append`, `sql`, `latest`, `maintain` with Arrow in and out. |
| Benchmark | Same ingest stream (TSBS IoT, 5-minute micro-batches) into naive Iceberg (PyIceberg appends, the S3 Tables write pattern), Iceberg after binpack compaction (S3 Tables' default maintenance), Lance (append, then compacted), and Timelake. Then TSBS IoT + single-device queries, local and on RustFS with 20 ms latency. |

**Out of scope (v0):** REST catalog server, hot tier / WAL, caggs, deletes/GDPR, backfill branches, TimescaleDB import, `timelake-ingest` service and rules, DuckDB extension, Vortex, schema evolution beyond add-column.

**Exit criteria:** On RustFS + 20 ms, Timelake's reader beats naive Iceberg + DuckDB and Lance on the TSBS IoT and single-device suites (geomean, first run), latest-value queries take tens of milliseconds, plain DuckDB reads every Timelake table with identical results, and no maintenance job outside Timelake is needed.

**Status (2026-10-12): implemented; exit criteria met** ([`bench/results/V0.md`](bench/results/V0.md)).
- **S3 (RustFS + 20 ms), first runs:**
  - Right after streaming ingest: 3.7× faster than Lance and 16× faster than naive Iceberg + DuckDB on TSBS IoT; 7.8–9× faster on single-truck queries.
  - After each system's maintenance: 1.2–1.5× faster on TSBS IoT, 2.2–2.7× on single-truck queries.
- **Local disk:** 2.7–3.8× faster on TSBS IoT, 7.7–10× on single-truck queries.
- **Latest-value queries:** 12 requests instead of 1,700–3,600.
- **Ingest on S3:** 2× faster than Lance and 3.7× faster than PyIceberg, including inline compaction.
- **Live size:** 228 MB, vs 262 MB (Iceberg) and 449 MB (Lance).
- **Compatibility:** plain DuckDB reads all tables with identical results.

Reader lessons, now defaults:
- Load all of a query's tables concurrently before planning.
- Read each Parquet footer once.
- Use more scan partitions on object storage.
- Write 1M-row row groups (page indexes keep single-series reads selective).
- Declare the sort order only when there are enough files to keep scans parallel.

Open from v0:
- A reader data cache: DuckDB still wins some repeat runs on its cached data.
- Plain DuckDB on Timelake files is slower than on PyArrow-written files on S3 (0.52 vs 0.42 s), which needs investigation.
- The REST catalog.

| Phase | Deliverable |
|-------|-------------|
| 0 | This spec. `timelake-bench` skeleton: TSBS IoT generator → Parquet, adapters for DuckDB+Iceberg and TimescaleDB as first baselines. Spikes: ✅ `iceberg-rust` write maturity (Q7); `replace` + deletion-vector commits via our own commit layer (D13); DataFusion vs. embedded DuckDB (Q12); Lakekeeper evaluation (Q2); Iceberg v3 engine-support survey (Q1). Benchmark harness. |
| 1 | `timelake-core` writer (contract, sorting, partitioning, batching, commits); `timelake-catalog` (object-store backend, REST spec); CLI create/adopt/query; **import** (CSV, Parquet, Iceberg/S3 Tables) and **backfill** (plan, final-layout write, branch staging, publish, resume); DuckDB reads committed tables |
| 2 | `timelake-maintain`: compaction, re-sort, dedup, retention, snapshot expiry, triggered by catalog events. Immutable deletes + audit table; GDPR erasure workflow. **TimescaleDB/Postgres import** with `--sync` cutover. |
| 3 | Caggs (incremental, hierarchical) + `timelake-functions` core (`time_bucket`, gapfill, locf, `time_weight`, `counter_agg`, percentiles) |
| 4 | DuckDB extension (functions, dedup-on-read, index-aware scans) |
| 5 | Hot tier (profile WAL vs. Valkey; ship both behind `HotStore`) + Timelake reader with merge, Puffin indexes, fast paths |
| 6 | `timelake-ingest` with MQTT/HTTP/Kafka and the rule engine + events table; data → events with pluggable sinks and commit-driven triggers (F3, §21.3) |
| 7 | Python package (PyO3 + maturin), docs site with recipes, published benchmarks; Vortex when Iceberg supports it |
| 8 | Agent access with permission sets (F1) and static read models for dashboards (F2) (§21) |
| Later | Computed metrics from user-defined Python functions (F4, §21.4) |

---

## 20. Open source vs. premium (draft, D12)

| Open source | Premium (candidates) |
|-------------|----------------------|
| Table conventions, writer, catalog, maintenance jobs | Industrial historian connectors (AVEVA PI, Ignition, PHD, IP.21), OPC-UA at scale |
| Ingestion pipeline + built-in rules | Managed/hosted control plane, UI, alert management |
| Caggs + function library, DuckDB extension, Python library | Enterprise SSO/RBAC, compliance reporting (GDPR erasure certificates as a service) |
| Import: CSV, Parquet, Iceberg/S3 Tables, Delta, TimescaleDB/Postgres, InfluxDB | Support / SLAs |

The principle: everything needed to run the lake well is open; integrations with proprietary industrial systems and managed operations are premium. The open-source part is Apache 2.0 (D7); premium components would live outside this repository.

---

## 21. Planned features

New product features beyond the original requirements, recorded on 2026-10-13. None of them is built yet. Each one keeps the rule that no always-on Timelake server is required (R13): state lives in the bucket and work is triggered by commits or schedules.

| ID | Feature | Req | Builds on | Phase |
|----|---------|-----|-----------|-------|
| F1 | Read access for LLM agents, with permission sets built in | R19 | Reader, multitenancy (§14) | 8 |
| F2 | Static read models in the bucket, generated from the frontend's Zod schemas and refreshed on ingest | R20 | `@timelake/client`, snapshot diffs (§11.1) | 8 |
| F3 | Data → events: produce any event type into any event stream | R21 | Rules (§13.3) | 6 |
| F4 | Computed metrics: user-defined Python functions applied automatically, like rollups | R22 | Caggs (§11.1), Python package | Later |

### 21.1 F1: Agent access with permission sets (R19)

LLM agents should be able to find, understand and read time-series data without a human writing SQL for them, and only see what they are allowed to.

- **Interface:** an MCP server (`timelake mcp`, local over stdio or hosted over HTTP) plus the same operations in the Python and TypeScript clients. Tools: list tables, describe a table (schema, contract, units, series-key meaning, time range), latest values, range query with a bucket and aggregate, and SQL.
- **Self-describing data:** column descriptions and units are stored as table properties, so an agent gets context instead of guessing what `v3` means.
- **Fits in a context window:** results are capped by rows and bytes; long ranges are downsampled automatically (`time_bucket`, `lttb`), and the response says it was downsampled. Every query has a scan budget (bytes, time) so a bad question can't run up an S3 bill.
- **Permission sets:** a named policy stored in the lake (`_timelake/policies/<name>.json`) lists allowed tables, columns, row filters (for example `site = 'plant-3'`, or a tenant), the maximum time window, and operations. Agents only ever get read access. The reader enforces a policy by rewriting the plan (row filter and column projection injected into the DataFusion plan) before it runs. An agent's credential names exactly one permission set.
- **The honest limit:** a policy enforced by the reader only binds clients that go through Timelake. Anyone holding raw bucket credentials can read the files. So the agent never receives bucket credentials: the MCP server holds them, or the REST catalog vends prefix-scoped credentials (§14).
- **Audit:** every agent query is logged with its permission set to an Iceberg table, consistent with D6.

### 21.2 F2: Static read models (R20)

Dashboards almost always ask the same thing: one device or asset, a recent time range, a few fields at a fixed resolution. F2 answers those requests with one object GET from the bucket or a CDN instead of planning a query.

- **Defined from the frontend:** a read model is declared next to the component that renders it, with the Zod schema of the shape it needs (`@timelake/client` already uses Zod) plus its query: source table or cagg, series key (device/asset), fields, aggregates and resolutions. A build step exports the definition (Zod → JSON Schema) to `_timelake/read-models/<name>.json`, so the lake knows what to precompute and the frontend gets typed results.
- **Time tiles:** results are stored like map tiles: per series, per resolution level, per fixed tile (for example 1-minute buckets in day tiles, 1-hour buckets in month tiles) at deterministic paths such as `read-models/<name>/<series>/<resolution>/<tile>.arrow`. Any time range is a few tiles. Closed tiles never change, so they cache forever; only the open (current) tile and tiles hit by late data are rewritten.
- **Invalidation and regeneration on ingest:** each commit knows which series and time partitions it touched (the same snapshot diff that drives incremental caggs). Only the affected tiles are regenerated, by the writer inline or by a commit-triggered job. A small per-model manifest records the snapshot each tile reflects, so readers and caches never mix versions.
- **Cost guardrails:** regeneration is debounced per model (at most once per N seconds) and can be limited to "hot" series, because each refresh is a PUT. Tiles are built from caggs where a matching cagg exists.
- **Browser path:** `timelake-wasm` / `@timelake/client` fetch tiles by path, stitch them, and fall back to a normal query when a model doesn't cover the request.

### 21.3 F3: Data → events (R21)

Turn incoming data into events and publish them into whatever event system the user already runs. This generalizes the rule outputs in §13.3.

- **Events are defined, not hard-coded:** an event is a typed record produced from data by a built-in rule (threshold, flatline, heartbeat, …), a SQL definition (state change, "batch arrived", a derived condition), or pass-through of rows (change-data-capture style). Its payload schema is declared (JSON Schema or Zod).
- **Any sink:** pluggable outputs for Kafka/Redpanda, NATS JetStream, MQTT, Kinesis, SQS/SNS, EventBridge, Google Pub/Sub, Azure Event Hubs, Redis Streams, and webhooks. CloudEvents is the default envelope.
- **Two triggers:** in-stream inside `timelake-ingest` for the lowest latency, or commit-driven: a function triggered per commit reads the snapshot diff, so any writer (CLI, Python, Spark) can produce events without running the ingest service.
- **Delivery:** at least once. Every event carries a deterministic ID (table, series, time, rule), so consumers can deduplicate. Events are emitted only after the commit succeeds and are also written to the `events` Iceberg table, which is the durable record and the replay source after a crash (a commit-driven outbox).

### 21.4 F4: Computed metrics (R22, later)

Let users define a Python function and the result it produces, for example a computed metric, and have Timelake keep that result up to date automatically, the way caggs keep rollups up to date.

- **Definition:** the function, its inputs (tables, series selection, window) and its output table with a normal contract. Sketch:
  ```python
  @tl.metric(inputs={"flow": "iot.flow", "power": "iot.power"},
             output="iot.pump_efficiency", window="1m", series="pump_id")
  def efficiency(flow: pl.DataFrame, power: pl.DataFrame) -> pl.DataFrame: ...
  ```
- **Incremental like caggs:** on each commit, compute which output windows are affected (snapshot diff), pass the inputs as Arrow (zero-copy into Polars or pandas), and replace those windows in the output table. Late data recomputes the affected windows the same way it does for caggs.
- **Contract for functions:** deterministic and per-window by default, so any window can be recomputed. State carried across windows is opt-in.
- **Where it runs:** in the writer's process (Python bindings), in a scheduled `timelake maintain` run, or in a Lambda. There is still no server. A hosted version needs sandboxing.
- **Composes:** computed metrics are ordinary tables, so they can feed read models (F2) and events (F3). SQL and Rust functions can follow on the same mechanism.
