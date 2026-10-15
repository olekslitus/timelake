# Shared settings for the bench/infra scripts (sourced). Uses the `timelake` AWS profile unless AWS_PROFILE is set or
# credentials are already in the environment (GitHub Actions).
if [ -z "${AWS_ACCESS_KEY_ID:-}" ]; then export AWS_PROFILE=${AWS_PROFILE:-timelake}; fi
export AWS_REGION=${AWS_REGION:-us-east-2}
STACK=${STACK:-timelake-bench}

output() {
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
