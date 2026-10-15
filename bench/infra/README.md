# Benchmarks on AWS

Runs `timebench` and the Phase 0 suites on real S3 (SPEC §17.4), including the weekly regression run. One CloudFormation stack in one zone holds:
- an S3 Standard bucket;
- an S3 Express One Zone bucket;
- an S3 Tables table bucket;
- optionally (`INSTANCE=true`), one benchmark instance.

## From a laptop (quick numbers)
```bash
aws login --profile timelake        # the scripts use profile timelake, region us-east-2
bench/infra/up.sh                   # buckets only
bench/run_aws.sh                    # several hours; results in bench/results/runs
uv run timebench report latest
bench/infra/down.sh                 # empties all buckets and deletes the stack
```
Latency then includes the trip from the laptop to us-east-2. Request counts, bytes and request cost don't depend on where the client runs, and every system takes the same path, so the comparisons hold. Only TSBS IoT runs this way: TPC-H and ClickBench scan hundreds of MB per query, and pulling that over the internet is slow and costs egress.

## From an instance in the region (publishable numbers)

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

```bash
git push                                        # the instance clones the current commit from GitHub
INSTANCE=true bench/infra/up.sh                 # a few minutes; first boot installs toolchains
bench/infra/ssm.sh --bg 'bench/infra/remote.sh all'
bench/infra/ssm.sh 'grep "^==" /mnt/bench/logs/all.log; tail -3 /mnt/bench/logs/all.log'   # progress
bench/infra/fetch.sh                            # results → bench/results/runs and bench/results/*aws*.jsonl
bench/infra/down.sh                             # empties the buckets and deletes the stack
```
- **Stages:** `remote.sh` runs build → data → queries on each target → direct → `bench` (timebench) on each target. Each stage can also run on its own, e.g. `remote.sh queries s3x`. To run new code, check it out first: `ssm.sh 'git fetch -q && git checkout -q origin/main'`.
- **Auto-stop:** the instance stops itself after 12 hours (`AutoStopMinutes`). Stopping wipes an NVMe SSD. Results are copied to `s3://<data bucket>/_out/` after every stage.
- **Duration and cost:** on `m7i-flex.large`, the Rust builds alone take about 1.5 hours, and a full run takes about 8 hours. At about $0.10/h, that's about $1. Storage and requests add cents.
- **Cleanup:** every resource carries the tag `project=timelake-bench`.

## Weekly runs
A second, long-lived stack (`timelake-bench-weekly`) holds one fixed instance, stopped between runs, plus a role that
GitHub Actions on `main` can assume to start it, run commands on it and read its results, and nothing else.
`.github/workflows/bench-weekly.yml` runs `weekly.sh` in two parts, so a run can take longer than a GitHub job may:
1. **start** (Mondays 06:00 UTC): start the instance, mount its NVMe SSD (stopping wipes it), check out the commit and
   start `remote.sh weekly` in the background: build, start TimescaleDB in a container, then
   `timebench profile weekly` on the local disk and on S3. Each target's run files go to the bucket as soon as they're
   done, and the instance stops itself at the end (or after 12 hours).
2. **collect** (hourly, Monday to Wednesday): copy the finished run files from the bucket into `bench/results/runs`
   and commit them to `main` with the website's copy.

Same machine, workloads and pinned competitor versions every week, so the history shows Timelake's changes. Stopped,
the instance costs only its 100 GB EBS volume.

One-time setup (with `aws login --profile timelake`; the commit must be pushed):
```bash
export STACK=timelake-bench-weekly
INSTANCE=true INSTANCE_TYPE=c8gd.2xlarge GITHUB_REPO=polythings/timelake bench/infra/up.sh
bench/infra/ssm.sh 'test -f /var/lib/timelake-bootstrap.done && echo ready'   # the first boot installs toolchains
gh variable set BENCH_ROLE_ARN --body "$(source bench/infra/env.sh && output GitHubRoleArn)"
gh workflow run bench-weekly.yml -f action=start                              # a first run now
```
`up.sh` asks GitHub for the repository's OIDC subject (immutable subjects carry owner and repository ids). If the
account already has an OIDC provider for `token.actions.githubusercontent.com`, pass its ARN as
`GITHUB_OIDC_PROVIDER_ARN=…`. By hand: `STACK=timelake-bench-weekly bench/infra/weekly.sh start`, later
`weekly.sh collect`.
