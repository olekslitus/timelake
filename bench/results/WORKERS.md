# Writes from Cloudflare Workers (2026-10-17)

`TableWriter` from `@timelake/client/workers` in workerd, Cloudflare's runtime, run locally through Miniflare
(4.20260730.0, workerd 2026-08-06 compatibility) with a local R2 bucket. Script: [`bench/workers`](../workers)
(`cd bench/workers && bun install && bun bench.ts`, with a release `timelake` CLI built). The table is created
with the CLI and copied into the bucket; rows are TSBS-like (time, `tags_id`, 7 doubles with noise), 100 or 1,000
devices, one reading per device every 10 s. Each measurement runs in a fresh isolate, so its memory is its own:
WebAssembly memory (what the module grew to; it never shrinks) and, in parentheses, the peak of heap bytes in use.
Times are wall time of the request in workerd on a laptop (M1 Pro), local R2 included; CPU time is lower.

| Run | Rows | Time | WASM memory (heap peak) | Result |
|---|---:|---:|---:|---|
| append, fresh isolate | 1,000 | 196 ms | 5 MiB (3 MiB) | 1 file |
| append, fresh isolate | 10,000 | 253 ms | 12 MiB (10 MiB) | 1 file |
| append, fresh isolate | 100,000 | 673 ms | 37 MiB (36 MiB) | 1 file |
| 60 appends with inline maintenance, one isolate | 1,000 each | median 18 ms, max 197 ms | 16 MiB (13 MiB) | 56 files compacted inline |
| `maintain({ maxBytes: 64 MiB })`, fresh isolate | 1,371,000 | 2,736 ms | 95 MiB (80 MiB) | 38 files (47 MiB) merged, among them a day of 24 files of 50,000 rows |

Afterwards the bucket is copied to disk and the engine reads 1,371,000 rows, as written.

## How memory came down

The first run of this benchmark exceeded a Worker's 128 MB. Each change below, measured on the same runs:

| Change | Append, 100k rows | Compaction (24 files) |
|---|---:|---:|
| First version (JSON rows through `serde_json`, compaction decoding whole row groups) | 161 MiB | 291 MiB |
| Rows decoded from newline-delimited JSON straight into Arrow | 37 MiB | |
| Row groups being written capped at 16 MiB | | 187 MiB |
| Inputs read a window of pages at a time (offset index) | | 177 MiB |
| Smaller read and merge batches (1,024 and 8,192 rows), 128 KiB windows, 8,192-row data pages, at most 24 files per merge | | 140 MiB (92 MiB heap) |
| Output as the writer's chunks, sent in parts of exactly 8 MiB (no doubling buffers) | | 95 MiB (80 MiB heap) |

- **Data page size** decides most of the rest: a merge holds a decompressed page per column of each input. Measured
  natively on the same 24 files (heap above the store's data, row groups capped at 16 MiB): 20,000-row pages 123 MiB,
  8,192 rows 97 MiB, 4,096 rows 85 MiB. Smaller windows don't help with 20,000-row pages (99 MiB, and 445 ms instead
  of 245 ms: windows smaller than a page fetch and decode the same page again).
- **Data page size on the engine side** (TSBS readings, 11.7M rows, one file per day, local disk, median first/warm
  run in ms):

  | Query | 20,000 | 8,192 | 4,096 |
  |---|---:|---:|---:|
  | one truck, a day's max | 5.7 / 1.8 | 6.4 / 1.8 | 6.4 / 2.0 |
  | one truck, an hour of rows | 5.0 / 1.6 | 5.4 / 1.6 | 6.0 / 1.7 |
  | fleet hourly average (scan) | 53.7 / 51.7 | 52.6 / 51.6 | 55.7 / 53.0 |
  | filtered count (scan) | 23.0 / 18.7 | 23.7 / 19.6 | 29.2 / 22.3 |
  | three trucks, a day | 6.1 / 2.5 | 6.6 / 2.4 | 7.1 / 2.4 |
  | live data | 200.0 MB | 207.1 MB (+3.6%) | 209.6 MB (+4.8%) |

  So the engine keeps 20,000-row pages (no change to its files), files written from JavaScript have 8,192-row pages,
  and the table setting `data-page-rows` overrides both.
- **Fragmentation:** WebAssembly memory only grows. Buffers that grew by doubling and were freed at other sizes
  left 50 MiB the allocator couldn't reuse (142 MiB memory for a 92 MiB heap peak); fixed-size parts and chunked
  output brought it to 15 MiB.

## Found on the way

- Workers don't compile WebAssembly from bytes at runtime ("Wasm code generation disallowed by embedder"), so the
  client's default entry, which embeds the module as base64, never ran in Workers, for reading either. Hence
  `@timelake/client/workers` with `initWasm` and `@timelake/client/timelake.wasm`.
- R2 multipart uploads need every part but the last to have the same size, and the last no larger.
