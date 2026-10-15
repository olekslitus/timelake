# v0 benchmark: Timelake vs. naive Iceberg (S3 Tables pattern) vs. Lance

The question: a team streams IoT data to object storage and queries it. Is Timelake v0 better than what it would
otherwise build: PyIceberg/Firehose appends into an S3 Tables-style Iceberg table, or a Lance dataset?

This is now the `tsbs-iot` workload of `timelake-bench` ([../README.md](../README.md)), which also runs plain Parquet
files and TimescaleDB, and keeps every run:
```bash
uv run timelake-bench run tsbs-iot --systems timelake,iceberg,lance            # local disk
bench/run_aws.sh bench-s3                                                       # AWS S3 and S3 Tables, from a laptop
```
The workload: TSBS IoT (`readings` and `diagnostics`, 11.7M rows each over 3 days, 500 trucks, plus `tags`), streamed
in 5-minute windows (Firehose's default buffer interval): 864 windows × 2 tables = 1,728 commits of about 13.5k
rows. Every system gets identical rows. Queries: the 12 TSBS IoT queries plus 5 single-truck queries, right after
ingest and after each system's maintenance.

The write-ups of the first runs (2026-10-12/13) are [V0.md](../results/V0.md), [S3.md](../results/S3.md) and
[TIMESCALE.md](../results/TIMESCALE.md). Their results are also in `results/runs/` as converted runs. The scripts that
produced them are in git history (`git checkout b99aae9 -- bench/v0`).

`small.py` here is a quick version for any S3-compatible store without the proxy (100 commits and four queries, small
enough for free tiers): see its docstring. Results of the performance plan's steps are in
[PERFORMANCE.md](../results/PERFORMANCE.md).
