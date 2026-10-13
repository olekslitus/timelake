# Shared settings for the bench/infra scripts (sourced). Uses the `timelake` AWS profile unless AWS_PROFILE is set.
export AWS_PROFILE=${AWS_PROFILE:-timelake} AWS_REGION=${AWS_REGION:-us-east-2}
STACK=${STACK:-timelake-bench}

output() {
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
