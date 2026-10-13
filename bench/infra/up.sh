#!/usr/bin/env bash
# Create or update the benchmark stack (stack.yaml): S3 Standard, S3 Express and S3 Tables buckets, and with
# INSTANCE=true a benchmark instance in the same zone. Log in first: aws login --profile timelake
#   bench/infra/up.sh                        buckets only; run bench/run_aws.sh from this machine
#   INSTANCE=true bench/infra/up.sh          plus the instance (checks out the current commit, which must be
#                                            pushed); then: bench/infra/ssm.sh --bg 'bench/infra/remote.sh all'
set -euo pipefail
cd "$(dirname "$0")"
source env.sh
AZ=${AZ:-use2-az1}
params=(Instance="${INSTANCE:-false}" AzId="$AZ")
if [ "${INSTANCE:-false}" = true ]; then
  REF=$(git rev-parse HEAD)
  git branch -r --contains "$REF" | grep -q . || { echo "push $REF first: the instance clones it from GitHub"; exit 1; }
  vpc=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
  subnet=$(aws ec2 describe-subnets --filters Name=vpc-id,Values="$vpc" Name=availability-zone-id,Values="$AZ" \
    --query 'Subnets[0].SubnetId' --output text)
  params+=(VpcId="$vpc" SubnetId="$subnet" RepoRef="$REF" ${INSTANCE_TYPE:+InstanceType=$INSTANCE_TYPE})
fi
aws cloudformation deploy --stack-name "$STACK" --template-file stack.yaml --capabilities CAPABILITY_IAM \
  --tags project=timelake-bench --parameter-overrides "${params[@]}"
aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Outputs' --output table
