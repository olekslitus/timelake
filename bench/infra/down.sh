#!/usr/bin/env bash
# Delete everything the stack created: empties the buckets (data and results) and the table bucket, then deletes
# the stack. Fetch results first (fetch.sh) if the instance ran.
set -euo pipefail
cd "$(dirname "$0")"
source env.sh
for b in "$(output DataBucket)" "$(output ExpressBucket)"; do
  aws s3 rm "s3://$b" --recursive --only-show-errors
done
arn=$(output TableBucketArn)
for ns in $(aws s3tables list-namespaces --table-bucket-arn "$arn" --query 'namespaces[].namespace[0]' --output text); do
  for t in $(aws s3tables list-tables --table-bucket-arn "$arn" --namespace "$ns" --query 'tables[].name' --output text); do
    aws s3tables delete-table --table-bucket-arn "$arn" --namespace "$ns" --name "$t"
  done
  aws s3tables delete-namespace --table-bucket-arn "$arn" --namespace "$ns"
done
aws cloudformation delete-stack --stack-name "$STACK"
aws cloudformation wait stack-delete-complete --stack-name "$STACK"
echo "$STACK deleted"
