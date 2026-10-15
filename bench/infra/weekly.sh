#!/usr/bin/env bash
# The weekly regression run (SPEC §17.4) on the weekly stack's instance: start it, run profiles/weekly.toml at a
# commit, copy the run files into bench/results/runs, stop it. Run by .github/workflows/bench-weekly.yml, or by hand:
#   STACK=timelake-bench-weekly bench/infra/weekly.sh [commit]      # default: HEAD, which must be pushed
# One-time setup of the stack: bench/infra/README.md, "Weekly runs".
set -euo pipefail
cd "$(dirname "$0")"
source env.sh
ref=${1:-$(git rev-parse HEAD)}
id=$(output InstanceId)
bucket=$(output DataBucket)
log=/mnt/bench/logs/weekly.log

stop() { aws ec2 stop-instances --instance-ids "$id" > /dev/null && echo "stopping $id"; }
trap stop EXIT

aws ec2 start-instances --instance-ids "$id" > /dev/null
aws ec2 wait instance-running --instance-ids "$id"
until [ "$(aws ssm describe-instance-information --filters Key=InstanceIds,Values="$id" \
  --query 'InstanceInformationList[0].PingStatus' --output text)" = Online ]; do sleep 10; done
echo "$id is up; running $ref"

# Stopping wiped the NVMe SSD: mount it again, then check out the commit (remote.sh runs from it).
./ssm.sh "sudo bench/infra/mount.sh > /dev/null 2>&1 && git fetch -q origin && git checkout -q $ref && git log -1 --oneline"
./ssm.sh --bg 'bench/infra/remote.sh weekly'
started=$(date +%s)
while :; do
  sleep 300
  # ssm.sh prints the command's stdout and stderr; pick the status word out of them. If SSM itself fails, keep going.
  state=$(./ssm.sh "if [ -f /mnt/bench/logs/weekly.done ]; then echo done; elif [ -f /mnt/bench/logs/weekly.failed ]; then echo failed; else echo running; fi" 2>&1 | grep -Eo 'done|failed|running' | head -1 || true)
  state=${state:-running}
  echo "$(( ($(date +%s) - started) / 60 )) min: $state"
  [ "$state" = running ] || break
done
./ssm.sh "tail -20 $log" || true
aws s3 sync "s3://$bucket/_out/runs" ../results/runs --only-show-errors
[ "$state" = done ]
