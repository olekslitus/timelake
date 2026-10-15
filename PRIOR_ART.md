# Prior art

Timelake stands on other open-source projects and learns from many more. This file credits what we took and keeps
our notes on what we're studying, so good ideas don't get lost and their authors get the recognition they're due.

How to credit a project (in code, docs and [NOTICE](NOTICE)) is in [CONTRIBUTING.md](CONTRIBUTING.md#credit). For
how Timelake compares with these projects as products, see SPEC.md §16. This file is about what we learn from them.

## What we took

### Foundations

Timelake is built on these. Their licenses ship with our packages through the normal dependency tooling.

| Project | License | What Timelake uses |
|---|---|---|
| [Apache Iceberg](https://iceberg.apache.org) | Apache-2.0 | The table format: metadata, snapshots, manifests, column bounds |
| [iceberg-rust](https://github.com/apache/iceberg-rust) | Apache-2.0 | Iceberg types and metadata. Our commit layer is our own code on its public types (D13) |
| [Apache Parquet](https://parquet.apache.org), [arrow-rs](https://github.com/apache/arrow-rs) | Apache-2.0 | Data files, the last-value index, footers; Arrow in memory and as the head codec |
| [Apache DataFusion](https://datafusion.apache.org) | Apache-2.0 | The embedded query engine (`time_bucket` is its `date_bin`) |
| [object_store](https://github.com/apache/arrow-rs-object-store) | Apache-2.0 | Every read and write to S3, GCS, Azure and local disk |
| [DuckDB](https://duckdb.org) | MIT | The plain-SQL way to read our tables (`iceberg_scan`); the planned extension |

### Ideas

Designs we adopted or plan to. None of these involved copying code.

| Idea | From | License of the source | Where in Timelake |
|---|---|---|---|
| Hypertable-like table contract, chunk interval, series key, `time_bucket`, continuous aggregates | [TimescaleDB](https://github.com/timescale/timescaledb) | Apache-2.0 core; continuous aggregates are under the Timescale License | SPEC §7, §11; `query/session.rs`, `query/mod.rs`; docs Concepts, Querying |
| Two-step aggregates and the target function library (planned) | [TimescaleDB Toolkit](https://github.com/timescale/timescaledb-toolkit) | Timescale License (source-available: learn from the docs, don't port the code) | SPEC §11 |
| Size-tiered compaction (D19) | [Apache Cassandra](https://cassandra.apache.org) (SizeTieredCompactionStrategy) | Apache-2.0 | `maintain.rs` |
| Table layout readable with no catalog service (D17) | Iceberg's Hadoop catalog | Apache-2.0 | `lake.rs`; docs Architecture |
| Stage on a branch, check, then publish (backfill, planned) | Write-audit-publish, from Netflix's Iceberg practice | Pattern | SPEC §8.4 |
| Ingest pipeline config `inputs → processors → rules → outputs` (planned) | [Telegraf](https://github.com/influxdata/telegraf) | MIT | SPEC §13 |
| `quality` column (good / uncertain / bad) | OPC UA | Specification | SPEC §7 |
| Commit operations to port (rewrite, row delta, branches, expiry) | [Iceberg Java](https://github.com/apache/iceberg), [iceberg-cpp](https://github.com/apache/iceberg-cpp), [iceberg-go](https://github.com/apache/iceberg-go) | Apache-2.0 | Reference implementations and test oracles (D13, `spikes/iceberg-write`). No code ported yet |
| Instrument-panel visual style | [Oxide](https://oxide.computer) | Design inspiration | `brand/README.md`, the website |

### Copied files

Third-party files in this repository. Each keeps its license, listed in [NOTICE](NOTICE).

| Files | From | License |
|---|---|---|
| `dashboard/assets/fonts/` | Geist and Geist Mono, by Vercel and basement.studio | SIL OFL 1.1 |
| `dashboard/components/ui/` | Generated with [shadcn/ui](https://ui.shadcn.com) | MIT |
| `bench/queries/tsbs_iot/` | Ported from [TSBS](https://github.com/timescale/tsbs) | MIT |
| `bench/queries/tpch/` | DuckDB's `tpch` extension (TPC-H queries) | MIT |
| `bench/queries/clickbench/` | [ClickBench](https://github.com/ClickHouse/ClickBench) | CC BY-NC-SA 4.0 (not Apache-2.0) |

## Studies

Notes on projects we've read closely. Checkboxes are ideas we may adopt; tick one when it ships, and credit the
project where it's implemented.

### IceGate

[icegatetech/icegate](https://github.com/icegatetech/icegate) · Apache-2.0 · Rust · studied 2026-10-15 (README and
crate docs, not a full code read)

An observability lake: OpenTelemetry logs, traces and events (metrics planned) in Iceberg + Parquet on object storage,
queried through Loki-, Tempo- and Flight SQL-compatible APIs, with a DataFusion engine. A prototype. It shares
Timelake's stack, not its use case.

**Catalog.** One `root.json` lists every table; a commit replaces it with a compare-and-swap on its ETag (`If-Match`).
That gives atomic multi-table commits, renames and drops, and one read lists every table. The cost: every commit in
the warehouse contends on one object, and other engines find tables only through their REST server. Timelake commits
each table on its own (`vN.metadata.json` put-if-absent, D17), so tables never contend and any engine reads a
table's directory; multi-table atomicity is what the optional REST catalog (D2) would add. Their documented
lost-acknowledgement case (a commit that landed but whose reply was lost gets applied again) is worth remembering for
any commit path without a batch id.

**Fresh data: a Parquet WAL on object storage.** This is SPEC §8.2 mode B, working:
1. Ingest buffers for up to 200 ms, writes one Parquet segment per topic with `If-None-Match` under an increasing
   offset, and replies only once the segment is stored.
2. A "shifter" turns segments into one Iceberg file per (tenant, day), commits, and records the committed offset.
3. A query reads the snapshot plus the segments above that offset, in one DataFusion plan.
4. Cleanup deletes segments below `committed − keep_segments_count`.

**Maintenance.** Merges small files and manifests, expires by TTL, removes orphans, and writes bloom filters on ID
columns such as `trace_id`, which aren't in the sort order.

**Ideas to adopt:**
- [ ] WAL rules for mode B (SPEC §8.3): delete segments by offset, never by age; size the kept margin to the longest
  query that may still be reading; a reader that meets a missing segment fails instead of returning fewer rows;
  recover offsets on restart with a search that still works across missing segments.
- [ ] One WAL object per request across all series and tenants, read with fan-out: on S3 a write costs about 10× a
  read.
- [ ] Evaluate Parquet instead of Arrow IPC for WAL segments: statistics let readers skip segments, and plain DuckDB
  can read them. It costs CPU on write.
- [ ] Compaction converges: merge a group only if it lowers the file count. Check that our size tiers
  (`maintain.rs`) guarantee the same, in a test.
- [ ] Opt-in bloom filters for high-cardinality columns outside the sort key, written by compaction only. Our sort
  order already prunes series-key lookups by min/max.
- [ ] Later: Prometheus- or Grafana-compatible read APIs for observability users.

### Earlier studies

- Iceberg write support across Java, C++, Go and Rust: [spikes/iceberg-write](spikes/iceberg-write/README.md).
- Vortex as a file format: [bench/results/VORTEX.md](bench/results/VORTEX.md).
- Lance, S3 Tables and PyIceberg on the same workload: [bench/results/S3.md](bench/results/S3.md).
- TimescaleDB on Tiger Cloud on the same workload: [bench/results/TIMESCALE.md](bench/results/TIMESCALE.md).

### Adding a study

Add a section with the link, license, language and the date you studied it; what it is in two lines; what it does
differently and the trade-off; and a checklist of ideas to adopt. Before reading a project's code, check its license:
from copyleft or source-available projects, learn from the docs and design, not the code
([CONTRIBUTING.md](CONTRIBUTING.md#credit)).
