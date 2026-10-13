#!/usr/bin/env bash
# Copy results and logs from the stack's bucket (s3://<data bucket>/_out/) into bench/results.
set -euo pipefail
cd "$(dirname "$0")"
source env.sh
aws s3 sync "s3://$(output DataBucket)/_out/results" ../results --exclude '*' --include '*aws*'
aws s3 sync "s3://$(output DataBucket)/_out/logs" ../results/aws-logs
