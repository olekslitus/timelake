#!/usr/bin/env bash
# Delete everything the stack created: empties both buckets (data and results), then deletes the stack.
# Fetch results first (fetch.sh).
set -euo pipefail
cd "$(dirname "$0")"
source env.sh
for b in "$(output DataBucket)" "$(output ExpressBucket)"; do
  aws s3 rm "s3://$b" --recursive --only-show-errors
done
aws cloudformation delete-stack --stack-name "$STACK"
aws cloudformation wait stack-delete-complete --stack-name "$STACK"
echo "$STACK deleted"
