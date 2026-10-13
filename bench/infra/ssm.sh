#!/usr/bin/env bash
# Run a command on the benchmark instance as ec2-user, in ~/timelake, via SSM (no SSH), and print its output.
#   bench/infra/ssm.sh 'tail -5 /mnt/bench/logs/all.log; ls /mnt/bench/logs'
#   bench/infra/ssm.sh --bg 'bench/infra/remote.sh all'    # detached; output in /mnt/bench/logs/<first word>.log
set -euo pipefail
cd "$(dirname "$0")"
source env.sh
bg=
if [ "${1:-}" = --bg ]; then bg=1; shift; fi
cmd=$1
if [ -n "$bg" ]; then
  log=/mnt/bench/logs/$(echo "$cmd" | awk '{print $NF}' | tr -c 'a-z0-9\n' -).log
  cmd="setsid nohup bash -c $(printf %q "$cmd") > $log 2>&1 < /dev/null & echo started, log $log"
fi
script="sudo -iu ec2-user bash -lc $(printf %q "cd ~/timelake && $cmd")"
id=$(output InstanceId)
cid=$(aws ssm send-command --instance-ids "$id" --document-name AWS-RunShellScript \
  --parameters "$(jq -n --arg c "$script" '{commands: [$c], executionTimeout: ["7200"]}')" \
  --query Command.CommandId --output text)
while :; do
  sleep 2
  status=$(aws ssm get-command-invocation --command-id "$cid" --instance-id "$id" --query Status --output text 2>/dev/null || echo Pending)
  case $status in Pending | InProgress | Delayed) ;; *) break ;; esac
done
aws ssm get-command-invocation --command-id "$cid" --instance-id "$id" \
  --query '[StandardOutputContent, StandardErrorContent]' --output text
[ "$status" = Success ]
