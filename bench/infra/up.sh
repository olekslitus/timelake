#!/usr/bin/env bash
# Create the benchmark stack: an instance plus S3 Standard and S3 Express buckets in one zone (stack.yaml).
# The instance checks out the current commit, which must be pushed. Log in first: aws login --profile timelake
#   bench/infra/up.sh                          then: bench/infra/ssm.sh --bg 'bench/infra/remote.sh all'
#   AZ=use2-az2 INSTANCE_TYPE=c8gd.4xlarge bench/infra/up.sh
set -euo pipefail
cd "$(dirname "$0")"
source env.sh
AZ=${AZ:-use2-az1}
REF=$(git rev-parse HEAD)
if aws cloudformation describe-stacks --stack-name "$STACK" > /dev/null 2>&1; then
  echo "$STACK already exists. Update code on the instance with: ssm.sh 'git pull'"; exit 1
fi
git branch -r --contains "$REF" | grep -q . || { echo "push $REF first: the instance clones it from GitHub"; exit 1; }
vpc=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
subnet=$(aws ec2 describe-subnets --filters Name=vpc-id,Values="$vpc" Name=availability-zone-id,Values="$AZ" \
  --query 'Subnets[0].SubnetId' --output text)
aws cloudformation deploy --stack-name "$STACK" --template-file stack.yaml --capabilities CAPABILITY_IAM \
  --tags project=timelake-bench \
  --parameter-overrides VpcId="$vpc" SubnetId="$subnet" AzId="$AZ" RepoRef="$REF" \
  ${INSTANCE_TYPE:+InstanceType=$INSTANCE_TYPE}
aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Outputs' --output table
