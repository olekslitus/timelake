# Performance plan results

Measurements for the steps of the performance plan ([SPEC.md §19.1](../../SPEC.md)), newest first. Each step is
measured from a laptop (M1 Pro) over the internet, against the numbers before it.

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

From this laptop, a TLS connection to Tigris is quicker (70 ms vs. 92 ms), but its time to first byte on small objects
varied from 30 to 155 ms after the connection, against a steady 60–75 ms on S3. Cold queries make 6–7 requests one
after another, so they add up that variance; P1 (one request for the table state) cuts most of them. One small run:
indicative only. The run used about 1,000 writes, under 1,000 reads and 33 MB on Tigris, inside its free tier.
