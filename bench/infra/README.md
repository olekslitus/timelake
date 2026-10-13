# Benchmarks on AWS

Runs the Phase 0 suites and the v0 benchmark on real S3 (SPEC §17.4). One CloudFormation stack in one zone holds:
- one benchmark instance;
- an S3 Standard bucket;
- an S3 Express One Zone bucket.

The default instance is `m7i-flex.large` (x86, 2 vCPU, 8 GB, EBS), the largest type the AWS Free plan allows. With the Paid plan, `INSTANCE_TYPE=c8gd.2xlarge` gives 8 Graviton vCPUs and a local NVMe SSD, closer to the Phase 0 laptop. That type also needs the stack's arm64 `ImageId`.

Each run covers three storage targets, all on the same machine:
| Target | Where the data is |
|---|---|
| `local` | the instance's own disk (`/mnt/bench`: NVMe SSD if it has one, else EBS gp3) |
| `s3` | S3 Standard, same region |
| `s3x` | S3 Express One Zone, same zone as the instance |

All S3 traffic goes through `tools/s3proxy` in AWS mode:
- Engines keep reading `s3://bench/...` over plain HTTP with dummy keys. The proxy maps that path to the real bucket and re-signs each request (SigV4; `CreateSession` for S3 Express).
- It counts requests by kind (GET, HEAD, LIST, PUT, ...) and the bytes returned. Those counts give the per-query request cost.
- Each client connection gets its own upstream TLS connection, so a fresh process pays the same connection setup it would pay talking to S3 directly.
- `remote.sh direct` measures what the proxy itself adds, by running plain DuckDB straight against S3.

## Run
```bash
aws login --profile timelake                    # the scripts use profile timelake, region us-east-2
git push                                        # the instance clones the current commit from GitHub
bench/infra/up.sh                               # a few minutes; first boot installs toolchains
bench/infra/ssm.sh --bg 'bench/infra/remote.sh all'
bench/infra/ssm.sh 'grep "^==" /mnt/bench/logs/all.log; tail -3 /mnt/bench/logs/all.log'   # progress
bench/infra/fetch.sh                            # results → bench/results/*aws*.jsonl
bench/infra/down.sh                             # empties both buckets and deletes the stack
```
- **Stages:** `remote.sh` runs build → data → queries on each target → direct → v0 on each target. Each stage can also run on its own, e.g. `remote.sh queries s3x`. To run new code, check it out first: `ssm.sh 'git fetch -q && git checkout -q origin/main'`.
- **Auto-stop:** the instance stops itself after 12 hours (`AutoStopMinutes`). Stopping wipes an NVMe SSD. Results are copied to `s3://<data bucket>/_out/` after every stage.
- **Duration and cost:** on `m7i-flex.large`, the Rust builds alone take about 1.5 hours, and a full run takes about 8 hours. At about $0.10/h, that's about $1. Storage and requests add cents.
- **Cleanup:** every resource carries the tag `project=timelake-bench`.
