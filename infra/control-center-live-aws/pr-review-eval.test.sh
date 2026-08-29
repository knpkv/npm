#!/usr/bin/env bash

set -euo pipefail

test_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly test_root
readonly fixture_account="123456789012"
readonly fixture_repository="fixture-repository"
readonly fixture_repository_id="9296f329-2be7-4a0e-ac8f-d8858273a5b5"
readonly fixture_token="123e4567-e89b-42d3-a456-426614174000"
readonly expected_main_commit="1111111111111111111111111111111111111111"
readonly expected_fixture_commit="2222222222222222222222222222222222222222"
test_workspace="$(mktemp -d)"
readonly test_workspace

# shellcheck source=pr-review-eval.sh
source "${test_root}/pr-review-eval.sh"

scenario="success"
calls_file=""

uuidgen() {
  printf '%s\n' "${fixture_token}"
}

stack_document() {
  jq -n \
    --arg account "${fixture_account}" \
    --arg repository "${fixture_repository}" \
    '{Stacks: [{StackStatus: "UPDATE_COMPLETE", Outputs: [
      {OutputKey: "AwsRoleArn", OutputValue: ("arn:aws:iam::" + $account + ":role/control-center-live")},
      {OutputKey: "CodeCommitRepository", OutputValue: $repository}
    ]}]}'
}

repository_document() {
  jq -n \
    --arg account "${fixture_account}" \
    --arg region "${aws_region}" \
    --arg repository "${fixture_repository}" \
    --arg repositoryId "${fixture_repository_id}" \
    '{repositoryMetadata: {
      repositoryName: $repository,
      repositoryId: $repositoryId,
      accountId: $account,
      Arn: ("arn:aws:codecommit:" + $region + ":" + $account + ":" + $repository)
    }}'
}

pull_request_document() {
  local candidate_id="$1"
  local description="not this fixture"
  local source="refs/heads/foreign-branch"
  if [[ "${candidate_id}" == "42" ]]; then
    description="Disposable Control Center PR-review evaluation fixture ${run_token}."
    source="refs/heads/${branch_name}"
  fi
  jq -n \
    --arg description "${description}" \
    --arg repository "${fixture_repository}" \
    --arg source "${source}" \
    '{pullRequest: {
      pullRequestStatus: "OPEN",
      description: $description,
      pullRequestTargets: [{
        repositoryName: $repository,
        sourceReference: $source,
        destinationReference: "refs/heads/main"
      }]
    }}'
}

aws() {
  printf '%s\n' "$*" >>"${calls_file}"
  case "$*" in
    "cloudformation describe-stacks"*) stack_document ;;
    "sts get-caller-identity"*)
      [[ "${scenario}" == "account-mismatch" ]] && printf '210987654321\n' || printf '%s\n' "${fixture_account}"
      ;;
    "cloudformation describe-stack-resource"*)
      local physical_id="${fixture_repository_id}"
      [[ "${scenario}" == "repository-id-mismatch" ]] && physical_id="11111111-2222-4333-8444-555555555555"
      jq -n --arg physicalId "${physical_id}" \
        '{StackResourceDetail: {PhysicalResourceId: $physicalId, ResourceStatus: "CREATE_COMPLETE"}}'
      ;;
    "codecommit get-repository"*) repository_document ;;
    "codecommit get-branch"*) printf '%s\n' "${expected_main_commit}" ;;
    "codecommit create-branch"*)
      [[ "${scenario}" == "branch-collision" ]] && return 1
      return 0
      ;;
    "codecommit put-file"*)
      [[ "${scenario}" == "put-file-fails" ]] && return 1
      printf '%s\n' "${expected_fixture_commit}"
      ;;
    "codecommit create-pull-request"*)
      if [[ "${scenario}" == "ambiguous-create" || "${scenario}" == "create-pr-unresolved" ]]; then
        return 1
      fi
      printf '42\n'
      ;;
    "codecommit list-pull-requests"*)
      [[ "${scenario}" == "ambiguous-create" ]] && printf '41\t42\n' || printf '41\n'
      ;;
    "codecommit get-pull-request"*)
      [[ "$*" == *"--pull-request-id 42"* ]] && pull_request_document 42 || pull_request_document 41
      ;;
    "codecommit update-pull-request-status"*)
      [[ "${scenario}" == "close-fails" ]] && return 1
      return 0
      ;;
    "codecommit delete-branch"*)
      [[ "${scenario}" == "delete-fails" ]] && return 1
      return 0
      ;;
    *) return 1 ;;
  esac
}

reset_fixture() {
  scenario="$1"
  calls_file="${test_workspace}/calls-$1-$RANDOM"
  : >"${calls_file}"
  aws_command=(aws)
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
  trap - EXIT INT TERM
}

assert_private_state() {
  [[ -f "${state_file}" ]]
  [[ "$(stat -c '%a' "${state_file}")" == "600" ]]
  [[ "$(stat -c '%a' "${state_root}")" == "700" ]]
}

assert_no_unrelated_calls() {
  ! grep -Eq 'codepipeline|bootstrap' "${calls_file}"
}

test_successful_lifecycle() {
  reset_fixture success
  local ready_file="${test_workspace}/ready-success"
  create_fixture >"${ready_file}"
  trap - EXIT INT TERM
  local ready
  ready="$(<"${ready_file}")"
  assert_private_state
  [[ "${ready}" == "READY ${state_file}" ]]
  [[ "${branch_name}" == "pr-review-eval-${fixture_token}" ]]
  jq -e \
    --arg head "${expected_fixture_commit}" \
    --arg token "${fixture_token}" \
    '.runToken == $token and .head == $head and .branchCreated and .pullRequestCreated and .pullRequestId == "42"' \
    "${state_file}" >/dev/null
  cleanup
  [[ ! -e "${state_root}" ]]
  local close_line
  local delete_line
  close_line="$(grep -n 'codecommit update-pull-request-status' "${calls_file}" | cut -d: -f1)"
  delete_line="$(grep -n 'codecommit delete-branch' "${calls_file}" | cut -d: -f1)"
  [[ "${close_line}" -lt "${delete_line}" ]]
  cleanup
  [[ "$(grep -c 'codecommit update-pull-request-status' "${calls_file}")" -eq 1 ]]
  [[ "$(grep -c 'codecommit delete-branch' "${calls_file}")" -eq 1 ]]
  assert_no_unrelated_calls
}

test_boundary_failures_write_nothing() {
  local boundary_scenario
  for boundary_scenario in account-mismatch repository-id-mismatch; do
    reset_fixture "${boundary_scenario}"
    local stderr_file="${test_workspace}/stderr-${boundary_scenario}"
    if create_fixture >/dev/null 2>"${stderr_file}"; then
      return 1
    fi
    trap - EXIT INT TERM
    ! grep -q 'codecommit create-branch' "${calls_file}"
    ! grep -q "${fixture_repository}" "${stderr_file}"
    ! grep -q "${fixture_account}" "${stderr_file}"
    cleanup
    assert_no_unrelated_calls
  done
}

test_branch_collision_preserves_foreign_branch() {
  reset_fixture branch-collision
  if create_fixture >/dev/null; then
    return 1
  fi
  trap - EXIT INT TERM
  assert_private_state
  [[ "${branch_created}" == false ]]
  cleanup
  ! grep -q 'codecommit delete-branch' "${calls_file}"
  assert_no_unrelated_calls
}

test_branch_mutation_is_journaled() {
  reset_fixture put-file-fails
  if create_fixture >/dev/null; then
    return 1
  fi
  trap - EXIT INT TERM
  assert_private_state
  jq -e '.branchCreated and .head == "" and (.pullRequestCreated | not)' "${state_file}" >/dev/null
  cleanup
  grep -q 'codecommit delete-branch' "${calls_file}"
}

test_head_mutation_is_journaled() {
  reset_fixture create-pr-unresolved
  if create_fixture >/dev/null; then
    return 1
  fi
  trap - EXIT INT TERM
  assert_private_state
  jq -e --arg head "${expected_fixture_commit}" \
    '.branchCreated and .head == $head and (.pullRequestCreated | not)' "${state_file}" >/dev/null
  cleanup
  ! grep -q 'codecommit update-pull-request-status' "${calls_file}"
}

test_ambiguous_pull_request_is_reconciled() {
  reset_fixture ambiguous-create
  create_fixture >/dev/null
  trap - EXIT INT TERM
  assert_private_state
  [[ "${pull_request_created}" == true && "${pull_request_id}" == "42" ]]
  jq -e '.pullRequestCreated and .pullRequestId == "42"' "${state_file}" >/dev/null
  grep -q 'codecommit list-pull-requests' "${calls_file}"
  grep -q 'codecommit get-pull-request --pull-request-id 42' "${calls_file}"
  cleanup
}

test_close_failure_keeps_complete_recovery_state() {
  reset_fixture success
  create_fixture >/dev/null
  trap - EXIT INT TERM
  scenario="close-fails"
  local stderr_file="${test_workspace}/stderr-close-fails"
  if cleanup 2>"${stderr_file}"; then
    return 1
  fi
  assert_private_state
  jq -e '.pullRequestCreated and .branchCreated' "${state_file}" >/dev/null
  ! grep -q 'codecommit delete-branch' "${calls_file}"
  grep -q 'Cleanup incomplete; recovery state retained at' "${stderr_file}"
  scenario="success"
  cleanup
}

test_delete_failure_keeps_remaining_recovery_state() {
  reset_fixture success
  create_fixture >/dev/null
  trap - EXIT INT TERM
  scenario="delete-fails"
  local stderr_file="${test_workspace}/stderr-delete-fails"
  if cleanup 2>"${stderr_file}"; then
    return 1
  fi
  assert_private_state
  jq -e '(.pullRequestCreated | not) and .branchCreated' "${state_file}" >/dev/null
  [[ "$(grep -c 'codecommit update-pull-request-status' "${calls_file}")" -eq 1 ]]
  scenario="success"
  cleanup
  [[ "$(grep -c 'codecommit update-pull-request-status' "${calls_file}")" -eq 1 ]]
}

test_focused_fixture() {
  grep -q 'gateway.charge(request, makeIdempotencyKey())' "${test_root}/pr-review-eval-fixture.ts"
  ! grep -Eq 'catch|throw|RangeError|randomUUID|setTimeout' "${test_root}/pr-review-eval-fixture.ts"
  ! grep -Eq 'codepipeline|bootstrap\.sh' "${test_root}/pr-review-eval.sh"
}

test_successful_lifecycle
test_boundary_failures_write_nothing
test_branch_collision_preserves_foreign_branch
test_branch_mutation_is_journaled
test_head_mutation_is_journaled
test_ambiguous_pull_request_is_reconciled
test_close_failure_keeps_complete_recovery_state
test_delete_failure_keeps_remaining_recovery_state
test_focused_fixture

rm -rf -- "${test_workspace}"
