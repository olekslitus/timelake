# Prior art

Timelake stands on other open-source projects and learns from many more. This file credits the ideas we took and
keeps our notes on what we're studying, so good ideas don't get lost and their authors get the recognition they're
due. We take ideas, never code: every line of Timelake is our own.

Which projects we credit, and how, is in [CONTRIBUTING.md](CONTRIBUTING.md#credit). For how Timelake compares with
other systems as products, see SPEC.md §16.

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

Methods we adopted or plan to, and implemented ourselves.

| Idea | From | License of the source | Where in Timelake |
|---|---|---|---|
| Size-tiered compaction (D19) | [Apache Cassandra](https://cassandra.apache.org) (SizeTieredCompactionStrategy) | Apache-2.0 | `maintain.rs` |
| Table layout readable with no catalog service (D17) | Iceberg's Hadoop catalog | Apache-2.0 | `lake.rs`; docs Architecture |
| Stage on a branch, check, then publish (backfill, planned) | Iceberg branches (write-audit-publish) | Apache-2.0 | SPEC §8.4 |
| `quality` column (good / uncertain / bad) | OPC UA | Specification | SPEC §7 |
| How commit operations work (rewrite, row delta, branches, expiry) | [Iceberg Java](https://github.com/apache/iceberg), [iceberg-cpp](https://github.com/apache/iceberg-cpp), [iceberg-go](https://github.com/apache/iceberg-go) | Apache-2.0 | References to learn from and test oracles (D13, `spikes/iceberg-write`); our commit layer is our own code |

### Third-party files

Files we use as they are, not code we write. Each keeps its license, listed in [NOTICE](NOTICE).

| Files | From | License |
|---|---|---|
| `dashboard/assets/fonts/` | Geist and Geist Mono, by Vercel and basement.studio | SIL OFL 1.1 |
| `dashboard/components/ui/` | Generated with [shadcn/ui](https://ui.shadcn.com) | MIT |
| `bench/queries/tsbs_iot/` | Ported from [TSBS](https://github.com/timescale/tsbs) | MIT |
| `bench/queries/tpch/` | DuckDB's `tpch` extension (TPC-H queries) | MIT |

## Studies

Notes on projects we've read closely. Checkboxes are ideas we may adopt; tick one when it ships, and credit the
project where it's implemented.

### IceGate

[icegatetech/icegate](https://github.com/icegatetech/icegate) · Apache-2.0 · Rust · studied 2026-10-15: README and
docs, then the code of ingest, the WAL queue, the query engine, maintenance and the catalog (commit `ef6b362`)

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
  order already prunes series-key lookups by min/max ([#33](https://github.com/polythings/timelake/issues/33)).
- [ ] Later: Prometheus- or Grafana-compatible read APIs for observability users.

**From the code.** Ranked by value to Timelake. Issue numbers mark ideas already tracked.

*Correctness*
- [ ] Expiry must stop, not delete, when a manifest list of a snapshot it keeps is missing. IceGate's garbage
  collection deletes nothing if the set of files still in use can't be read in full. Our `reachable()`
  (`maintain.rs`) skips a missing list for kept snapshots too, so with [#21](https://github.com/polythings/timelake/issues/21) expiry would delete live data files.
- [ ] Carry state that must survive onto every commit, compaction included. IceGate's compaction once dropped the
  WAL offset from its replace snapshots and the shifter restarted from zero; now every commit copies it forward and
  readers refuse to start without it. Our compaction commits with empty snapshot properties, so the SPEC §8.3 WAL
  mark would be lost the same way.
- [ ] Batch-id idempotency ends when snapshots expire: `is_duplicate` only walks the snapshots still kept (1 h and at
  least 5 by default), so a late retry on a busy table writes twice. IceGate uses one increasing offset per writer
  ("committed ≥ mine" means done), which never expires. Keep a bounded list of recent ids, or a per-writer sequence,
  independent of expiry, and say what the window is in the docs.
- [ ] Check a rewrite before committing it: rows out (plus duplicates removed) equal rows in, and the min and max of
  the sort columns are unchanged, read from the new files' statistics at no extra cost.
- [ ] Orphan cleanup (promised in SPEC §10): list the table prefix, delete only unreferenced files older than a grace
  period, keep anything with an unknown layout, offer a dry run. Normalise listed keys and referenced paths with the
  same function: IceGate deleted a live file over percent-escaped partition values.
- [ ] A dropped and recreated table can receive a commit from a writer that still had the old one open. Give each
  table creation its own location, or a table id the commit checks.

*Write path and maintenance*
- [ ] Compact with a streaming k-way merge of the already-sorted inputs, holding only overlapping groups in memory
  ([#14](https://github.com/polythings/timelake/issues/14)). Equal keys ordered by input position keep "latest write wins".
- [ ] Commit each compaction group on its own, with a byte budget per group, so a Lambda timeout keeps the work
  already done; a group whose inputs disappeared is skipped, not an error.
- [ ] Plan compaction output so files have disjoint key ranges ([#12](https://github.com/polythings/timelake/issues/12)), and rewrite a closed partition whole once it's
  past its end plus a grace period.
- [ ] Record each WAL segment's sort-key range in its footer metadata, so the flush and readers skip segments by
  series without reading them. Take time ranges from column statistics, not from the composite key's ends.
- [ ] Never advance the WAL offset for a flush that produced no rows or files.
- [ ] Ingest backpressure: refuse at once when the queue is full (nothing enqueued, a retry is safe); cap the wait for
  a durable write below the client's timeout and say the write may still land; check the tenant before decompressing;
  limit the decompressed size.
- [ ] Delta encoding for monotonic integer counters (meters), after a benchmark.

*Read path*
- [ ] Load each table once when many queries arrive together: one task reloads, the others wait and reuse the
  result. A dashboard opening sends 10–20 cold queries at once; `Lake::table_recent` doesn't merge concurrent loads.
- [ ] Answer "list the series" (`SELECT DISTINCT <series key>`) from the last-value index, like the latest-value
  rewrite.
- [ ] For the local cache (§19.1 P5): a sparse byte-range cache on disk that fetches only the missing gaps, plus
  write-through for files this process wrote. Our files never change, so entries never need invalidating.
- [ ] Report per query: files pruned, footers from the head versus fetched, GETs and bytes ([#17](https://github.com/polythings/timelake/issues/17)).
- [ ] Count storage requests by kind inside the library (wrap the store once per process), so a maintenance run
  reports what it cost.
- [ ] Re-apply tenant filters to rows when permissions arrive (§14, F1): pushdown into our provider only prunes.
- [ ] Cap the number of time buckets a query may produce.

**What to avoid.** IceGate reloads every table every 15 s whether used or not, scans Iceberg as one partition and
ignores `LIMIT`, lists every WAL segment per scan, drops casts when converting filters (wrong pruning), caches HEAD
results with a TTL, re-commits on retry without re-checking the offset, expires snapshots only inside commits (idle
tables never shrink), and has no fault-injection tests. Timelake already avoids each of these; keep it that way.

### Earlier studies

- Iceberg write support across Java, C++, Go and Rust: [spikes/iceberg-write](spikes/iceberg-write/README.md).
- Vortex as a file format: [bench/results/VORTEX.md](bench/results/VORTEX.md).

Comparisons with other systems on the same workload are benchmark results, not studies: see `bench/results/`.

### Adding a study

Add a section with the link, license, language and the date you studied it; what it is in two lines; what it does
differently and the trade-off; and a checklist of ideas to adopt. Study the method, not code to copy, and check the
project's license first: open-core, dual-licensed and commercial projects aren't named as a source
([CONTRIBUTING.md](CONTRIBUTING.md#credit)).
