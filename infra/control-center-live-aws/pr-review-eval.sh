#!/usr/bin/env bash

set -euo pipefail
umask 077

readonly stack_name="${CONTROL_CENTER_LIVE_AWS_STACK_NAME:-control-center-live-fixtures}"
readonly aws_region="${CONTROL_CENTER_LIVE_AWS_REGION:-eu-central-1}"
readonly aws_profile="${AWS_PROFILE:-dev-administratoraccess}"
script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly script_root
readonly fixture_file="${script_root}/pr-review-eval-fixture.ts"
aws_command=(aws --profile "${aws_profile}" --region "${aws_region}")

repository_name=""
branch_name=""
head_commit=""
pull_request_id=""
expected_account_id=""
run_token=""
state_root=""
state_file=""
branch_created=false
pull_request_created=false
pull_request_ownership="none"

fail() {
  printf '%s\n' "$1" >&2
  return 1
}

capture_aws() {
  local output
  if ! output="$("${aws_command[@]}" "$@" 2>/dev/null)"; then
    return 1
  fi
  printf '%s\n' "${output}"
}

run_aws_quiet() {
  "${aws_command[@]}" "$@" >/dev/null 2>&1
}

make_run_token() {
  local token
  token="$(uuidgen | tr '[:upper:]' '[:lower:]')"
  [[ "${token}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] ||
    fail "Unable to create a UUID-quality fixture identity"
  printf '%s\n' "${token}"
}

journal_state() {
  local temporary_state
  [[ -n "${state_root}" && -d "${state_root}" && -n "${state_file}" ]] || return 1
  temporary_state="$(mktemp "${state_root}/.fixture.XXXXXX")"
  if ! jq -n \
    --arg account "${expected_account_id}" \
    --arg branch "${branch_name}" \
    --arg head "${head_commit}" \
    --arg pullRequestId "${pull_request_id}" \
    --arg pullRequestOwnership "${pull_request_ownership}" \
    --arg region "${aws_region}" \
    --arg repository "${repository_name}" \
    --arg runToken "${run_token}" \
    --arg url "$([[ -n "${pull_request_id}" ]] && printf 'https://%s.console.aws.amazon.com/codesuite/codecommit/repositories/%s/pull-requests/%s?region=%s' "${aws_region}" "${repository_name}" "${pull_request_id}" "${aws_region}")" \
    --argjson branchCreated "${branch_created}" \
    --argjson pullRequestCreated "${pull_request_created}" \
    '{account: $account, region: $region, repository: $repository, runToken: $runToken, branch: $branch, branchCreated: $branchCreated, head: $head, pullRequestId: $pullRequestId, pullRequestCreated: $pullRequestCreated, pullRequestOwnership: $pullRequestOwnership, url: $url}' \
    >"${temporary_state}"; then
    rm -f -- "${temporary_state}"
    return 1
  fi
  chmod 600 "${temporary_state}"
  mv -f -- "${temporary_state}" "${state_file}"
}

verify_fixture_boundary() {
  local caller_account
  local fixture_role_arn
  local repository_arn
  local repository_id
  local repository_metadata
  local repository_resource
  local repository_resource_id
  local repository_resource_status
  local stack_document
  local stack_status
  local partition

  stack_document="$(capture_aws cloudformation describe-stacks --stack-name "${stack_name}" --output json)" ||
    return 1
  repository_name="$(jq -er '.Stacks | if length == 1 then .[0].Outputs[] | select(.OutputKey == "CodeCommitRepository") | .OutputValue else empty end' <<<"${stack_document}" 2>/dev/null)" ||
    return 1
  fixture_role_arn="$(jq -er '.Stacks[0].Outputs[] | select(.OutputKey == "AwsRoleArn") | .OutputValue' <<<"${stack_document}" 2>/dev/null)" ||
    return 1
  stack_status="$(jq -er '.Stacks[0].StackStatus' <<<"${stack_document}" 2>/dev/null)" || return 1
  [[ "${stack_status}" =~ ^(CREATE|IMPORT|UPDATE|UPDATE_ROLLBACK)_COMPLETE$ ]] || return 1
  if [[ ! "${fixture_role_arn}" =~ ^arn:(aws|aws-us-gov):iam::([0-9]{12}):role/ ]]; then
    return 1
  fi
  partition="${BASH_REMATCH[1]}"
  expected_account_id="${BASH_REMATCH[2]}"

  caller_account="$(capture_aws sts get-caller-identity --query Account --output text)" || return 1
  [[ "${caller_account}" == "${expected_account_id}" ]] || return 1

  repository_resource="$(capture_aws cloudformation describe-stack-resource \
    --stack-name "${stack_name}" \
    --logical-resource-id FixtureRepository \
    --output json)" || return 1
  repository_resource_id="$(jq -er '.StackResourceDetail.PhysicalResourceId' <<<"${repository_resource}" 2>/dev/null)" ||
    return 1
  repository_resource_status="$(jq -er '.StackResourceDetail.ResourceStatus' <<<"${repository_resource}" 2>/dev/null)" ||
    return 1
  [[ "${repository_resource_status}" =~ ^(CREATE|IMPORT|UPDATE)_COMPLETE$ ]] || return 1

  repository_metadata="$(capture_aws codecommit get-repository \
    --repository-name "${repository_name}" \
    --output json)" || return 1
  [[ "$(jq -er '.repositoryMetadata.repositoryName' <<<"${repository_metadata}" 2>/dev/null)" == "${repository_name}" ]] ||
    return 1
  repository_id="$(jq -er '.repositoryMetadata.repositoryId' <<<"${repository_metadata}" 2>/dev/null)" || return 1
  [[ "${repository_id}" == "${repository_resource_id}" ]] || return 1
  [[ "$(jq -er '.repositoryMetadata.accountId' <<<"${repository_metadata}" 2>/dev/null)" == "${expected_account_id}" ]] ||
    return 1
  repository_arn="$(jq -er '.repositoryMetadata.Arn' <<<"${repository_metadata}" 2>/dev/null)" || return 1
  [[ "${repository_arn}" == "arn:${partition}:codecommit:${aws_region}:${expected_account_id}:${repository_name}" ]]
}

find_created_pull_request() {
  local candidate_id
  local candidate_ids
  local candidate_json
  local matches=()
  candidate_ids="$(capture_aws codecommit list-pull-requests \
    --repository-name "${repository_name}" \
    --pull-request-status OPEN \
    --query pullRequestIds \
    --output text)" || return 1
  for candidate_id in ${candidate_ids}; do
    [[ "${candidate_id}" =~ ^[0-9]+$ ]] || continue
    candidate_json="$(capture_aws codecommit get-pull-request \
      --pull-request-id "${candidate_id}" \
      --output json)" || return 1
    if jq -e \
      --arg branch "${branch_name}" \
      --arg repository "${repository_name}" \
      --arg token "${run_token}" \
      '.pullRequest as $pr |
        $pr.pullRequestStatus == "OPEN" and
        $pr.description == ("Disposable Control Center PR-review evaluation fixture " + $token + ".") and
        ($pr.pullRequestTargets | length) == 1 and
        $pr.pullRequestTargets[0].repositoryName == $repository and
        ($pr.pullRequestTargets[0].sourceReference == $branch or $pr.pullRequestTargets[0].sourceReference == ("refs/heads/" + $branch)) and
        ($pr.pullRequestTargets[0].destinationReference == "main" or $pr.pullRequestTargets[0].destinationReference == "refs/heads/main")' \
      <<<"${candidate_json}" >/dev/null 2>&1; then
      matches+=("${candidate_id}")
    fi
  done
  [[ "${#matches[@]}" -eq 1 ]] || return 1
  printf '%s\n' "${matches[0]}"
}

cleanup() {
  local cleanup_failed=false

  if [[ "${pull_request_ownership}" == "uncertain" ]]; then
    cleanup_failed=true
  elif [[ "${pull_request_created}" == true ]]; then
    if run_aws_quiet codecommit update-pull-request-status \
      --pull-request-id "${pull_request_id}" \
      --pull-request-status CLOSED; then
      pull_request_created=false
      pull_request_ownership="none"
      if ! journal_state; then
        cleanup_failed=true
      fi
    else
      cleanup_failed=true
    fi
  fi

  if [[ "${cleanup_failed}" == false && "${branch_created}" == true ]]; then
    if run_aws_quiet codecommit delete-branch \
      --repository-name "${repository_name}" \
      --branch-name "${branch_name}"; then
      branch_created=false
      if ! journal_state; then
        cleanup_failed=true
      fi
    else
      cleanup_failed=true
    fi
  fi

  if [[ "${cleanup_failed}" == true ]]; then
    printf 'Cleanup incomplete; recovery state retained at %s\n' "${state_file}" >&2
    return 1
  fi
  if [[ -n "${state_root}" && -d "${state_root}" && "${state_file}" == "${state_root}/fixture.json" ]]; then
    rm -rf -- "${state_root}"
  fi
}

handle_exit() {
  local original_status=$?
  trap - EXIT INT TERM
  if cleanup; then
    exit "${original_status}"
  fi
  exit 1
}

handle_signal() {
  local signal_status="$1"
  trap - EXIT INT TERM
  if cleanup; then
    exit "${signal_status}"
  fi
  exit 1
}

create_fixture() {
  local create_pull_request_output
  local main_commit

  command -v jq >/dev/null 2>&1 || fail "jq is required"
  command -v uuidgen >/dev/null 2>&1 || fail "uuidgen is required"
  run_token="$(make_run_token)"
  state_root="$(mktemp -d)"
  chmod 700 "${state_root}"
  state_file="${state_root}/fixture.json"
  trap handle_exit EXIT
  trap 'handle_signal 130' INT
  trap 'handle_signal 143' TERM

  if ! verify_fixture_boundary; then
    fail "AWS account, stack, or repository did not match the live fixture boundary"
    return 1
  fi
  branch_name="pr-review-eval-${run_token}"
  journal_state || return 1

  main_commit="$(capture_aws codecommit get-branch \
    --repository-name "${repository_name}" \
    --branch-name main \
    --query branch.commitId \
    --output text)" || return 1
  [[ "${main_commit}" =~ ^[0-9a-f]{40}$ ]] || return 1

  if ! run_aws_quiet codecommit create-branch \
    --repository-name "${repository_name}" \
    --branch-name "${branch_name}" \
    --commit-id "${main_commit}"; then
    return 1
  fi
  branch_created=true
  journal_state || return 1

  head_commit="$(capture_aws codecommit put-file \
    --repository-name "${repository_name}" \
    --branch-name "${branch_name}" \
    --file-path eval/idempotency-retry.ts \
    --file-content "fileb://${fixture_file}" \
    --parent-commit-id "${main_commit}" \
    --commit-message "Add retry helper eval fixture" \
    --query commitId \
    --output text)" || return 1
  [[ "${head_commit}" =~ ^[0-9a-f]{40}$ ]] || return 1
  journal_state || return 1

  pull_request_ownership="uncertain"
  if ! journal_state; then
    pull_request_ownership="none"
    return 1
  fi
  if create_pull_request_output="$(capture_aws codecommit create-pull-request \
    --title "Preserve idempotency keys across retries [${run_token}]" \
    --description "Disposable Control Center PR-review evaluation fixture ${run_token}." \
    --targets "repositoryName=${repository_name},sourceReference=${branch_name},destinationReference=main" \
    --query pullRequest.pullRequestId \
    --output text)"; then
    if [[ "${create_pull_request_output}" =~ ^[0-9]+$ ]]; then
      pull_request_id="${create_pull_request_output}"
    else
      pull_request_id="$(find_created_pull_request)" || return 1
    fi
  else
    pull_request_id="$(find_created_pull_request)" || return 1
  fi
  [[ "${pull_request_id}" =~ ^[0-9]+$ ]] || return 1
  pull_request_ownership="owned"
  pull_request_created=true
  journal_state || return 1

  printf 'READY %s\n' "${state_file}"
}

main() {
  create_fixture
  while IFS= read -r command; do
    [[ "${command}" == "stop" ]] && return
  done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
