# Performance plan results

Measurements for the steps of the performance plan ([SPEC.md §19.1](../../SPEC.md)), newest first. Each step is
measured from a laptop (M1 Pro) over the internet, against the numbers before it.

## P2 + P3: footers in the head, connections opened early (2026-10-14)

- **P2:** the head also carries the Parquet footers (with page indexes) of the newest files, in what the last-value
  index leaves of the 1 MiB budget, so a cold scan doesn't read footers first.
- **Cold load in one round trip:** on stores that list by prefix, a cold load lists `metadata/v` while it reads the
  head. The listing says which version is newest, so a current head needs no second request. A reader that already has
  a version checks only for `vN+1`, without downloading the head again.
- **P3:** a cold load also sends 4 small HEAD requests, so the data reads that follow find open connections.

Unit test (`cold_queries_read_the_head_first`): a cold `latest` waits for 1 round trip (P1: 2, before: 3), a cold
filtered scan for 2 (P1: 3, before: 6).

**Tigris, cold queries only** (`v0/small.py --queries-only --cold-runs 5` on warehouses written by the full runs,
three batches alternating between setups; median of 15 first runs in a fresh `Lake`, ms):

| First query | No head | Head + footers | + 4 warm-up connections |
|---|---:|---:|---:|
| `one-truck-latest` | 810 | 210 | 213 |
| `last-loc` | 762 | 269 | 273 |
| `one-truck-history` | 1,187 | 522 | 497 |
| `fleet-avg-velocity` | 1,094 | 511 | 492 |

P1 alone measured 318 / 446 / 1,052 / 714 ms on Tigris (one run each, below). Opening connections early saves about
20 ms on the scans and nothing on point queries: less than expected, but it costs 4 HEAD requests per cold load, so it
stays on (`timelake_warm_connections=0` turns it off). Queries-only runs read but don't write, so they are cheap to
repeat on a free tier. S3 numbers for this step are still to be measured.

## P1: one-request table state (2026-10-14)

After each commit the writer also writes `metadata/timelake-head` in the background: the table metadata, the live files
with their statistics, and the last-value index while it fits in 1 MB. A cold reader loads it instead of the version
hint, metadata, manifest list and manifests, and checks that no newer version exists while the query is planned (HEAD of
`vN+1.metadata.json`; a LIST of that name on Tigris). Unit test (`cold_queries_read_the_head_first` in
`crates/timelake/src/head/mod.rs`): a cold `latest` waits for 2 round trips instead of 3, a filtered scan for 3
instead of 6.

**Small run** (`v0/small.py --windows 50`, with `--head-format none` for "before"; raw lines in
[small.laptop.jsonl](small.laptop.jsonl)). First query in a fresh `Lake`, in ms; S3 is the mean of two runs each, Tigris
one run each:

| First query | S3 before | S3 P1 | Tigris before | Tigris P1 |
|---|---:|---:|---:|---:|
| `one-truck-latest` | 502 | 314 | 868 | 318 |
| `last-loc` | 676 | 421 | 1,097 | 446 |
| `one-truck-history` | 986 | 823 | 1,484 | 1,052 |
| `fleet-avg-velocity` | 1,013 | 780 | 1,143 | 714 |

Warm queries and commits don't change (the head is written after the commit returns). Tigris "before" already uses the
LIST check, which is why it is lower than the 1,005 ms of the P4 run. The rest of a cold query is mostly opening
connections (P3) and reading Parquet footers (P2). The two Tigris runs used about 2,600 writes, 2,000 reads and 70 MB,
inside the free tier.

## P4: two-step commit (2026-10-13)

An append now encodes its data files, manifests, manifest list and last-value index, uploads them all at once, then
makes the one conditional write. The version hint is updated in the background. Unit test: an append waits for 2
round trips instead of 5 (`append_takes_two_round_trips` in `crates/timelake/src/commit.rs`).

**v0 ingest on S3 us-east-2** (1,728 commits, `v0/ingest.py --system timelake --storage s3` through `tools/s3proxy`,
the `aws-s3-p4` record in [v0_ingest.laptop.jsonl](v0_ingest.laptop.jsonl); before: [S3.md](S3.md)):

| | Before | P4 |
|---|---:|---:|
| Commit p50 | 483 ms | 243 ms |
| Commit p95 | 2,007 ms | 1,630 ms |
| Whole ingest | 1,307 s | 795 s |
| Objects / data files written | 1,083 / 286 | 1,083 / 286 |

p95 is mostly the inline compactions (235 of them), which read data back and are bound by bytes, not round trips.

**Tigris vs. S3, small run** (`v0/small.py --windows 50`: 100 commits, then 4 queries, first run in a fresh process
and best of 2 warm runs; Tigris bucket in its global location):

| | S3 us-east-2 | Tigris (global) |
|---|---:|---:|
| Commit p50 / p95 | 198 / 1,086 ms | 252 / 863 ms |
| `one-truck-latest` first / warm | 553 / 1 ms | 1,005 / 1 ms |
| `last-loc` first / warm | 673 / 66 ms | 1,084 / 57 ms |
| `one-truck-history` first / warm | 1,062 / 139 ms | 1,973 / 270 ms |
| `fleet-avg-velocity` first / warm | 1,010 / 160 ms | 1,255 / 170 ms |

Cold queries are slower on Tigris because of one request type, not the store overall: see "Why Tigris was slower
here" below. One small run: indicative only. The run used about 1,000 writes, under 1,000 reads and 33 MB on Tigris, inside its free tier.

### Why Tigris was slower here (2026-10-13)

Per request on a warm connection from the same laptop (`p50 / p90` ms, 10 requests each, boto3):

| Request | S3 us-east-2 | Tigris (global) |
|---|---:|---:|
| GET, 2-byte object | 67 / 72 | 37 / 38 |
| HEAD, existing object | 53 / 61 | 36 / 44 |
| **HEAD, missing object (404)** | **53 / 56** | **283 / 314** |
| GET, missing object (404) | 61 / 70 | 285 / 311 |
| GET, 256 KB range | 70 / 79 | 59 / 67 |
| PUT, 1 KB | 114 / 120 | 79 / 88 |
| PUT, `If-None-Match: *` | 107 / 110 | 82 / 88 |
| LIST, one table's `metadata/` | 82 / 96 | 55 / 58 |
| LIST, keys after `v9` | 51 / 56 | 38 / 42 |

Tigris is faster for every request that finds its object, as it claims. Its own benchmark (1 KB objects, a client in
San Jose next to a Tigris region, YCSB) measures exactly those. A key that doesn't exist costs about 285 ms, likely
because a global bucket has to check beyond the nearest region. Timelake's reader looks up `vN+1.metadata.json`
(normally missing) on every table load, so each cold query on Tigris pays it once or twice. Checking with a LIST of the
`vN+1` prefix instead would take about 40 ms there (SPEC §17.4 and §19.2).
