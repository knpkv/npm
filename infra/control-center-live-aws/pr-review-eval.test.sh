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
export CONTROL_CENTER_PR_REVIEW_RECOVERY_ROOT="${test_workspace}/recovery"

# shellcheck source=pr-review-eval.sh
source "${test_root}/pr-review-eval.sh"

scenario="success"
calls_file=""
branch_owner_file=""
branch_head_file=""

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
  local status="OPEN"
  if [[ "${candidate_id}" == "42" ]]; then
    description="Disposable Control Center PR-review evaluation fixture ${run_token}."
    source="refs/heads/${branch_name}"
    [[ "${scenario}" == "already-closed" ]] && status="CLOSED"
  fi
  jq -n \
    --arg description "${description}" \
    --arg pullRequestId "${candidate_id}" \
    --arg repository "${fixture_repository}" \
    --arg source "${source}" \
    --arg status "${status}" \
    '{pullRequest: {
      pullRequestId: $pullRequestId,
      pullRequestStatus: $status,
      description: $description,
      pullRequestTargets: [{
        repositoryName: $repository,
        sourceReference: $source,
        destinationReference: "refs/heads/main"
      }]
    }}'
}

aws() {
  if [[ "${1:-}" == "--profile" ]]; then
    shift 4
  fi
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
    "codecommit get-branch"*)
      if [[ "$*" == *"--branch-name main"* ]]; then
        printf '%s\n' "${expected_main_commit}"
      elif [[ "${scenario}" == "branch-read-fails" ]]; then
        printf '{"Message":"private %s %s","Code":"ThrottlingException"}\n' \
          "${fixture_account}" "${fixture_repository}" >&2
        return 1
      elif [[ "${scenario}" == "branch-absent" || "$(<"${branch_owner_file}")" == "none" ]]; then
        jq -nc '{Message: "fixture branch does not exist", Code: "BranchDoesNotExistException"}' >&2
        return 1
      else
        jq -n --arg commitId "$(<"${branch_head_file}")" '{branch: {commitId: $commitId}}'
      fi
      ;;
    "codecommit create-branch"*)
      if [[ "${scenario}" == "branch-collision" ]]; then
        jq -nc '{Message: "fixture branch already exists", Code: "BranchNameExistsException"}' >&2
        return 1
      fi
      jq -e '.branchOwnership == "uncertain" and (.branchCreated | not)' "${state_file}" >/dev/null || return 1
      printf 'fixture\n' >"${branch_owner_file}"
      printf '%s\n' "${expected_main_commit}" >"${branch_head_file}"
      [[ "${scenario}" == "ambiguous-branch-create" ]] && return 1
      return 0
      ;;
    "codecommit put-file"*)
      [[ "${scenario}" == "put-file-fails" ]] && return 1
      printf '%s\n' "${expected_fixture_commit}" >"${branch_head_file}"
      printf '%s\n' "${expected_fixture_commit}"
      ;;
    "codecommit create-pull-request"*)
      if [[ "${scenario}" == "ambiguous-create" || "${scenario}" == "create-pr-unresolved" ]]; then
        return 1
      fi
      [[ "${scenario}" == "malformed-create" ]] && printf 'not-a-pull-request-id\n' || printf '42\n'
      ;;
    "codecommit list-pull-requests"*)
      [[ "${scenario}" == "malformed-create" ]] && return 1
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
      [[ "$(<"${branch_owner_file}")" == "fixture" ]] || return 1
      printf 'none\n' >"${branch_owner_file}"
      : >"${branch_head_file}"
      return 0
      ;;
    *) return 1 ;;
  esac
}

reset_fixture() {
  scenario="$1"
  calls_file="${test_workspace}/calls-$1-$RANDOM"
  : >"${calls_file}"
  branch_owner_file="${test_workspace}/branch-owner-$1-$RANDOM"
  branch_head_file="${test_workspace}/branch-head-$1-$RANDOM"
  if [[ "${scenario}" == "branch-collision" ]]; then
    printf 'foreign\n' >"${branch_owner_file}"
  else
    printf 'none\n' >"${branch_owner_file}"
  fi
  : >"${branch_head_file}"
  aws_command=(aws)
  repository_name=""
  branch_name=""
  head_commit=""
  pull_request_id=""
  expected_account_id=""
  run_token=""
  state_root=""
  state_file=""
  branch_ownership="none"
  pull_request_ownership="none"
  trap - EXIT INT TERM
}

discard_runtime_state() {
  repository_name=""
  branch_name=""
  head_commit=""
  pull_request_id=""
  expected_account_id=""
  run_token=""
  state_root=""
  state_file=""
  branch_ownership="none"
  pull_request_ownership="none"
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

test_china_partition_fixture_boundary() {
  local identity
  identity="$(fixture_role_identity \
    "arn:aws-cn:iam::${fixture_account}:role/control-center-live" \
    "cn-north-1")"

  [[ "${identity}" == $'aws-cn\t123456789012' ]]
  [[ "$(console_host_for_region "cn-north-1")" == "cn-north-1.console.amazonaws.cn" ]]
  if fixture_role_identity \
    "arn:aws:iam::${fixture_account}:role/control-center-live" \
    "cn-north-1" >/dev/null; then
    return 1
  fi

  local china_state_root="${test_workspace}/china-journal"
  mkdir -p -- "${china_state_root}"
  chmod 700 "${china_state_root}"
  CONTROL_CENTER_LIVE_AWS_REGION=cn-north-1 bash -c '
    source "$1"
    state_root="$2"
    state_file="${state_root}/fixture.json"
    expected_account_id="$3"
    repository_name="$4"
    run_token="$5"
    branch_name="pr-review-eval-${run_token}"
    branch_ownership="owned"
    head_commit="$6"
    pull_request_id="42"
    pull_request_ownership="owned"
    journal_state
  ' _ "${test_root}/pr-review-eval.sh" "${china_state_root}" "${fixture_account}" \
    "${fixture_repository}" "${fixture_token}" "${expected_fixture_commit}"
  jq -e \
    '.region == "cn-north-1" and .url == "https://cn-north-1.console.amazonaws.cn/codesuite/codecommit/repositories/fixture-repository/pull-requests/42?region=cn-north-1"' \
    "${china_state_root}/fixture.json" >/dev/null
}

test_successful_lifecycle() {
  reset_fixture success
  local ready_file="${test_workspace}/ready-success"
  create_fixture >"${ready_file}"
  trap - EXIT INT TERM
  local recovery_line
  local ready_line
  local url="https://eu-central-1.console.aws.amazon.com/codesuite/codecommit/repositories/${fixture_repository}/pull-requests/42?region=eu-central-1"
  recovery_line="$(sed -n '1p' "${ready_file}")"
  ready_line="$(sed -n '2p' "${ready_file}")"
  assert_private_state
  [[ "${recovery_line}" == "RECOVERY ${state_file}" ]]
  [[ "${ready_line}" == "READY ${state_file}" ]]
  [[ "${branch_name}" == "pr-review-eval-${fixture_token}" ]]
  jq -e \
    --arg head "${expected_fixture_commit}" \
    --arg token "${fixture_token}" \
    --arg url "${url}" \
    '.runToken == $token and .head == $head and .branchCreated and .branchOwnership == "owned" and .pullRequestCreated and .pullRequestOwnership == "owned" and .pullRequestId == "42" and .url == $url' \
    "${state_file}" >/dev/null
  local cleanup_stderr="${test_workspace}/stderr-success-cleanup"
  cleanup 2>"${cleanup_stderr}"
  [[ ! -s "${cleanup_stderr}" ]]
  [[ ! -e "${state_root}" ]]
  [[ "$(<"${branch_owner_file}")" == "none" ]]
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
  [[ "${branch_ownership}" == "none" ]]
  jq -e '.branchOwnership == "none" and (.branchCreated | not)' "${state_file}" >/dev/null
  cleanup
  [[ "$(<"${branch_owner_file}")" == "foreign" ]]
  ! grep -q 'codecommit delete-branch' "${calls_file}"
  assert_no_unrelated_calls
}

test_ambiguous_branch_create_retains_recovery_state() {
  reset_fixture ambiguous-branch-create
  if create_fixture >/dev/null; then
    return 1
  fi
  trap - EXIT INT TERM
  assert_private_state
  jq -e '.branchOwnership == "uncertain" and (.branchCreated | not)' "${state_file}" >/dev/null
  if cleanup 2>/dev/null; then
    return 1
  fi
  [[ "$(<"${branch_owner_file}")" == "fixture" ]]
  ! grep -q 'codecommit delete-branch' "${calls_file}"
  assert_private_state
}

test_branch_mutation_is_journaled() {
  reset_fixture put-file-fails
  local output_file="${test_workspace}/output-put-file-fails"
  local stderr_file="${test_workspace}/stderr-put-file-fails"
  if create_fixture >"${output_file}" 2>"${stderr_file}"; then
    return 1
  fi
  trap - EXIT INT TERM
  assert_private_state
  jq -e --arg head "${expected_main_commit}" \
    '.branchCreated and .branchOwnership == "owned" and .head == $head and (.pullRequestCreated | not)' \
    "${state_file}" >/dev/null
  [[ "$(<"${output_file}")" == "RECOVERY ${state_file}" ]]
  grep -q 'Unable to write the evaluation change to the fixture branch' "${stderr_file}"
  ! grep -Eq "${fixture_account}|${fixture_repository}" "${stderr_file}"
  cleanup
  grep -q 'codecommit delete-branch' "${calls_file}"
}

test_changed_branch_refuses_cleanup() {
  reset_fixture success
  create_fixture >/dev/null
  trap - EXIT INT TERM
  printf '3333333333333333333333333333333333333333\n' >"${branch_head_file}"
  local stderr_file="${test_workspace}/stderr-changed-branch"

  if cleanup 2>"${stderr_file}"; then
    return 1
  fi

  [[ -f "${state_file}" ]]
  [[ "$(<"${branch_owner_file}")" == "fixture" ]]
  grep -q 'Branch cleanup refused because its exact head could not be verified' "${stderr_file}"
  ! grep -Eq "${fixture_account}|${fixture_repository}" "${stderr_file}"
  ! grep -q 'codecommit delete-branch' "${calls_file}"
  printf '%s\n' "${expected_fixture_commit}" >"${branch_head_file}"
  cleanup
}

test_branch_verification_keeps_provider_errors_in_memory() {
  reset_fixture success
  create_fixture >/dev/null
  trap - EXIT INT TERM
  local isolated_tmp="${test_workspace}/provider-error-tmp"
  mkdir -p -- "${isolated_tmp}"
  scenario="branch-read-fails"

  if TMPDIR="${isolated_tmp}" verify_recovery_branch 2>/dev/null; then
    return 1
  fi

  [[ -z "$(find "${isolated_tmp}" -mindepth 1 -maxdepth 1 -print -quit)" ]]
  scenario="success"
  cleanup
}

test_fresh_process_recovery() {
  reset_fixture success
  create_fixture >/dev/null
  trap - EXIT INT TERM
  local journal="${state_file}"
  local journal_root="${state_root}"
  local recovery_output="${test_workspace}/fresh-process-recovery-output"

  (
    export scenario calls_file branch_owner_file branch_head_file
    export fixture_account fixture_repository fixture_repository_id
    export expected_main_commit expected_fixture_commit
    export -f aws stack_document repository_document pull_request_document
    AWS_PROFILE="dev-administratoraccess" \
      CONTROL_CENTER_LIVE_AWS_REGION="eu-central-1" \
      CONTROL_CENTER_PR_REVIEW_RECOVERY_ROOT="${recovery_root}" \
      bash "${test_root}/pr-review-eval.sh" recover "${journal}"
  ) >"${recovery_output}"

  [[ ! -e "${journal_root}" ]]
  [[ "$(<"${branch_owner_file}")" == "none" ]]
  [[ "$(<"${recovery_output}")" == "RECOVERED ${journal}" ]]
  local close_line
  local delete_line
  close_line="$(grep -n 'codecommit update-pull-request-status' "${calls_file}" | tail -1 | cut -d: -f1)"
  delete_line="$(grep -n 'codecommit delete-branch' "${calls_file}" | tail -1 | cut -d: -f1)"
  [[ "${close_line}" -lt "${delete_line}" ]]
}

test_uncertain_pull_request_recovery() {
  reset_fixture create-pr-unresolved
  if create_fixture >/dev/null; then
    return 1
  fi
  trap - EXIT INT TERM
  local journal="${state_file}"
  scenario="ambiguous-create"
  discard_runtime_state

  recover_fixture "${journal}"

  grep -q 'codecommit get-pull-request --pull-request-id 42' "${calls_file}"
  grep -q 'codecommit update-pull-request-status --pull-request-id 42' "${calls_file}"
  [[ "$(<"${branch_owner_file}")" == "none" ]]
}

test_uncertain_branch_recovery_refuses_mutation() {
  reset_fixture ambiguous-branch-create
  if create_fixture >/dev/null; then
    return 1
  fi
  trap - EXIT INT TERM
  local journal="${state_file}"
  local calls_before
  local stderr_file="${test_workspace}/stderr-uncertain-branch-recovery"
  calls_before="$(wc -l <"${calls_file}")"
  discard_runtime_state

  if recover_fixture "${journal}" 2>"${stderr_file}"; then
    return 1
  fi

  [[ -f "${journal}" ]]
  [[ "$(<"${branch_owner_file}")" == "fixture" ]]
  grep -q 'Branch ownership is uncertain; recovery state retained for operator resolution' "${stderr_file}"
  ! tail -n "+$((calls_before + 1))" "${calls_file}" | grep -Eq 'update-pull-request-status|delete-branch'
}

test_tampered_recovery_journal_refuses_mutation() {
  reset_fixture success
  create_fixture >/dev/null
  trap - EXIT INT TERM
  local journal="${state_file}"
  local temporary="${state_root}/tampered"
  jq '.account = "210987654321"' "${journal}" >"${temporary}"
  chmod 600 "${temporary}"
  mv -f -- "${temporary}" "${journal}"
  local calls_before
  local stderr_file="${test_workspace}/stderr-tampered-recovery"
  calls_before="$(wc -l <"${calls_file}")"
  discard_runtime_state

  if recover_fixture "${journal}" 2>"${stderr_file}"; then
    return 1
  fi

  [[ -f "${journal}" ]]
  grep -q 'Recovery journal does not belong to the verified fixture repository' "${stderr_file}"
  ! tail -n "+$((calls_before + 1))" "${calls_file}" | grep -Eq 'update-pull-request-status|delete-branch'
}

test_recovery_path_boundary() {
  reset_fixture success
  create_fixture >/dev/null
  trap - EXIT INT TERM
  local journal="${state_file}"
  local original_state_root="${state_root}"
  local calls_before
  local outside_root="${test_workspace}/outside-recovery"
  local symlink_root="${recovery_root}/symlink-run"
  local public_root="${recovery_root}/public-run"
  local public_file_root="${recovery_root}/public-file-run"
  mkdir -p -- "${outside_root}" "${public_root}" "${public_file_root}"
  chmod 700 "${outside_root}" "${public_file_root}"
  chmod 755 "${public_root}"
  cp -- "${journal}" "${outside_root}/fixture.json"
  cp -- "${journal}" "${public_root}/fixture.json"
  cp -- "${journal}" "${public_file_root}/fixture.json"
  chmod 600 "${outside_root}/fixture.json" "${public_root}/fixture.json"
  chmod 644 "${public_file_root}/fixture.json"
  ln -s -- "${outside_root}" "${symlink_root}"
  calls_before="$(wc -l <"${calls_file}")"

  local invalid_journal
  for invalid_journal in \
    "${outside_root}/fixture.json" \
    "${symlink_root}/fixture.json" \
    "${public_root}/fixture.json" \
    "${public_file_root}/fixture.json"; do
    if load_recovery_state "${invalid_journal}" 2>/dev/null; then
      return 1
    fi
  done

  local symlink_journal_root="${recovery_root}/symlink-journal-run"
  mkdir -p -- "${symlink_journal_root}"
  chmod 700 "${symlink_journal_root}"
  ln -s -- "${journal}" "${symlink_journal_root}/fixture.json"
  if load_recovery_state "${symlink_journal_root}/fixture.json" 2>/dev/null; then
    return 1
  fi
  local linked_recovery_root="${test_workspace}/linked-recovery-root"
  ln -s -- "${outside_root}" "${linked_recovery_root}"
  if CONTROL_CENTER_PR_REVIEW_RECOVERY_ROOT="${linked_recovery_root}" bash -c \
    'source "$1"; prepare_recovery_root' _ "${test_root}/pr-review-eval.sh" 2>/dev/null; then
    return 1
  fi
  if CONTROL_CENTER_PR_REVIEW_RECOVERY_ROOT="relative-recovery-root" bash -c \
    'source "$1"; prepare_recovery_root' _ "${test_root}/pr-review-eval.sh" 2>/dev/null; then
    return 1
  fi
  [[ "$(wc -l <"${calls_file}")" -eq "${calls_before}" ]]

  load_recovery_state "${journal}"
  [[ "${state_root}" == "${original_state_root}" ]]
  cleanup
}

test_unexpected_recovery_file_preserves_journal() {
  reset_fixture success
  create_fixture >/dev/null
  trap - EXIT INT TERM
  local unexpected_file="${state_root}/operator-note"
  : >"${unexpected_file}"
  local stderr_file="${test_workspace}/stderr-unexpected-recovery-file"

  if cleanup 2>"${stderr_file}"; then
    return 1
  fi

  [[ -f "${state_file}" ]]
  [[ -f "${unexpected_file}" ]]
  grep -q 'recovery directory contains unexpected files' "${stderr_file}"
  rm -f -- "${unexpected_file}"
  cleanup
}

test_recovery_accepts_already_removed_resources() {
  reset_fixture success
  create_fixture >/dev/null
  trap - EXIT INT TERM
  local journal="${state_file}"
  local journal_root="${state_root}"
  scenario="already-closed"
  printf 'none\n' >"${branch_owner_file}"
  discard_runtime_state

  scenario="already-closed"
  recover_fixture "${journal}"

  [[ ! -e "${journal_root}" ]]
  ! grep -q 'codecommit update-pull-request-status --pull-request-id 42 --pull-request-status CLOSED' "${calls_file}"
}

test_uncertain_create_retains_recovery_state() {
  reset_fixture create-pr-unresolved
  if create_fixture >/dev/null; then
    return 1
  fi
  trap - EXIT INT TERM
  assert_private_state
  jq -e --arg head "${expected_fixture_commit}" \
    '.branchCreated and .head == $head and .pullRequestOwnership == "uncertain" and (.pullRequestCreated | not)' \
    "${state_file}" >/dev/null
  if cleanup 2>/dev/null; then
    return 1
  fi
  ! grep -q 'codecommit update-pull-request-status' "${calls_file}"
  ! grep -q 'codecommit delete-branch' "${calls_file}"
  assert_private_state
}

test_malformed_create_retains_recovery_state() {
  reset_fixture malformed-create
  if create_fixture >/dev/null; then
    return 1
  fi
  trap - EXIT INT TERM
  assert_private_state
  jq -e '.pullRequestOwnership == "uncertain" and (.pullRequestCreated | not)' "${state_file}" >/dev/null
  if cleanup 2>/dev/null; then
    return 1
  fi
  ! grep -q 'codecommit update-pull-request-status' "${calls_file}"
  ! grep -q 'codecommit delete-branch' "${calls_file}"
  assert_private_state
}

test_ambiguous_pull_request_is_reconciled() {
  reset_fixture ambiguous-create
  create_fixture >/dev/null
  trap - EXIT INT TERM
  assert_private_state
  [[ "${pull_request_ownership}" == "owned" && "${pull_request_id}" == "42" ]]
  jq -e '.pullRequestCreated and .pullRequestOwnership == "owned" and .pullRequestId == "42"' \
    "${state_file}" >/dev/null
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
  grep -q 'Pull request cleanup failed while closing the owned fixture' "${stderr_file}"
  grep -q 'Cleanup incomplete; recovery state retained at' "${stderr_file}"
  ! grep -Eq "${fixture_account}|${fixture_repository}" "${stderr_file}"
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
  grep -q 'Branch cleanup failed while deleting the verified fixture' "${stderr_file}"
  ! grep -Eq "${fixture_account}|${fixture_repository}" "${stderr_file}"
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
test_china_partition_fixture_boundary
test_boundary_failures_write_nothing
test_branch_collision_preserves_foreign_branch
test_ambiguous_branch_create_retains_recovery_state
test_branch_mutation_is_journaled
test_changed_branch_refuses_cleanup
test_branch_verification_keeps_provider_errors_in_memory
test_fresh_process_recovery
test_uncertain_pull_request_recovery
test_uncertain_branch_recovery_refuses_mutation
test_tampered_recovery_journal_refuses_mutation
test_recovery_path_boundary
test_unexpected_recovery_file_preserves_journal
test_recovery_accepts_already_removed_resources
test_uncertain_create_retains_recovery_state
test_malformed_create_retains_recovery_state
test_ambiguous_pull_request_is_reconciled
test_close_failure_keeps_complete_recovery_state
test_delete_failure_keeps_remaining_recovery_state
test_focused_fixture

rm -rf -- "${test_workspace}"
