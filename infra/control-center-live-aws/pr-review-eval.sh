#!/usr/bin/env bash

set -euo pipefail
umask 077

readonly stack_name="${CONTROL_CENTER_LIVE_AWS_STACK_NAME:-control-center-live-fixtures}"
readonly aws_region="${CONTROL_CENTER_LIVE_AWS_REGION:-eu-central-1}"
readonly aws_profile="${AWS_PROFILE:-dev-administratoraccess}"
readonly recovery_root="${CONTROL_CENTER_PR_REVIEW_RECOVERY_ROOT:-${XDG_STATE_HOME:-${HOME}/.local/state}/control-center/pr-review-eval}"
script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly script_root
readonly fixture_file="${script_root}/pr-review-eval-fixture.ts"
readonly git_credential_helper="${script_root}/pr-review-eval-git-credential-helper.sh"
aws_command=(aws --profile "${aws_profile}" --region "${aws_region}")

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

aws_partition_for_region() {
  case "$1" in
    cn-*) printf 'aws-cn\n' ;;
    us-gov-*) printf 'aws-us-gov\n' ;;
    *) printf 'aws\n' ;;
  esac
}

fixture_role_identity() {
  local account
  local expected_partition
  local partition
  local role_arn="$1"
  local region="$2"
  if [[ ! "${role_arn}" =~ ^arn:(aws|aws-cn|aws-us-gov):iam::([0-9]{12}):role/ ]]; then
    return 1
  fi
  account="${BASH_REMATCH[2]}"
  partition="${BASH_REMATCH[1]}"
  expected_partition="$(aws_partition_for_region "${region}")" || return 1
  [[ "${partition}" == "${expected_partition}" ]] || return 1
  printf '%s\t%s\n' "${partition}" "${account}"
}

console_host_for_region() {
  local region="$1"
  case "$(aws_partition_for_region "${region}")" in
    aws-cn) printf '%s.console.amazonaws.cn\n' "${region}" ;;
    aws-us-gov) printf '%s.console.amazonaws-us-gov.com\n' "${region}" ;;
    aws) printf '%s.console.aws.amazon.com\n' "${region}" ;;
  esac
}

git_host_for_region() {
  local region="$1"
  case "$(aws_partition_for_region "${region}")" in
    aws-cn) printf 'git-codecommit.%s.amazonaws.com.cn\n' "${region}" ;;
    aws | aws-us-gov) printf 'git-codecommit.%s.amazonaws.com\n' "${region}" ;;
  esac
}

delete_branch_exact_head() {
  local repository_url
  printf -v repository_url 'https://%s/v1/repos/%s' \
    "$(git_host_for_region "${aws_region}")" "${repository_name}"
  delete_git_branch_exact_head "${repository_url}" "${branch_name}" "${head_commit}" "${state_root}"
}

delete_git_branch_exact_head() (
  local branch="$2"
  local credential_helper_command
  local environment_name
  local expected_head="$3"
  local isolated_repository
  local repository_url="$1"
  local temporary_root="$4"

  while IFS='=' read -r -d '' environment_name _; do
    case "${environment_name^^}" in
      GIT_*) unset "${environment_name}" ;;
    esac
  done < <(env -0)
  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_CONFIG_NOSYSTEM=1
  export GIT_TERMINAL_PROMPT=0

  isolated_repository="$(mktemp -d "${temporary_root}/.git-delete.XXXXXX")" || return 1
  chmod 700 -- "${isolated_repository}" || return 1
  trap 'rm -rf -- "${isolated_repository}"' EXIT
  git init --bare --quiet "${isolated_repository}" >/dev/null 2>&1 || return 1
  printf -v credential_helper_command '!bash %q' "${git_credential_helper}"
  CONTROL_CENTER_CODECOMMIT_GIT_PROFILE="${aws_profile}" \
    CONTROL_CENTER_CODECOMMIT_GIT_REGION="${aws_region}" \
    git -C "${isolated_repository}" \
      -c credential.helper= \
      -c "credential.helper=${credential_helper_command}" \
      -c credential.interactive=false \
      -c core.hooksPath=/dev/null \
      -c credential.UseHttpPath=true \
      push --porcelain \
      --force-with-lease="refs/heads/${branch}:${expected_head}" \
      "${repository_url}" \
      ":refs/heads/${branch}" >/dev/null 2>&1
)

cleanup_stale_git_repositories() (
  local candidate
  local candidate_name
  local owner_and_mode

  shopt -s nullglob
  for candidate in "${state_root}"/.git-delete.*; do
    candidate_name="${candidate##*/}"
    [[ "${candidate_name}" =~ ^\.git-delete\.[[:alnum:]]{6}$ ]] || continue
    [[ -d "${candidate}" && ! -L "${candidate}" ]] || continue
    owner_and_mode="$(stat -c '%u:%a' -- "${candidate}")" || return 1
    [[ "${owner_and_mode}" == "$(id -u):700" ]] || continue
    rm -rf -- "${candidate}" || return 1
  done
)

prepare_recovery_root() {
  if [[ "${recovery_root}" != /* ]]; then
    fail "Recovery root must be an absolute dedicated directory"
    return
  fi
  if [[ -e "${recovery_root}" && ( ! -d "${recovery_root}" || -L "${recovery_root}" ) ]]; then
    fail "Recovery root must be a real directory"
    return
  fi
  mkdir -p -- "${recovery_root}" || {
    fail "Unable to create the recovery root"
    return
  }
  chmod 700 "${recovery_root}" || {
    fail "Unable to protect the recovery root"
    return
  }
  [[ "$(stat -c '%u:%a' "${recovery_root}")" == "$(id -u):700" ]] ||
    fail "Recovery root must be owned by the current user with mode 0700"
}

verify_cleanup_prerequisites() {
  command -v aws >/dev/null 2>&1 || fail "AWS CLI is required"
  command -v git >/dev/null 2>&1 || fail "git is required"
  command -v jq >/dev/null 2>&1 || fail "jq is required"
  [[ -f "${git_credential_helper}" && ! -L "${git_credential_helper}" ]] ||
    fail "The CodeCommit Git credential helper is required"
}

load_recovery_state() {
  local canonical_recovery_root
  local document
  local requested_state_file="$1"

  prepare_recovery_root || return 1
  canonical_recovery_root="$(cd "${recovery_root}" && pwd -P)" || return 1
  [[ -f "${requested_state_file}" && ! -L "${requested_state_file}" ]] || {
    fail "Recovery journal must be a real regular file"
    return
  }
  state_root="$(cd "$(dirname "${requested_state_file}")" && pwd -P)" || return 1
  state_file="${state_root}/$(basename "${requested_state_file}")"
  [[ "${state_file}" == "${state_root}/fixture.json" ]] || {
    fail "Recovery journal must be named fixture.json"
    return
  }
  [[ "$(dirname "${state_root}")" == "${canonical_recovery_root}" ]] || {
    fail "Recovery journal is outside the configured recovery root"
    return
  }
  [[ "$(stat -c '%u:%a' "${state_root}")" == "$(id -u):700" ]] || {
    fail "Recovery directory must be owned by the current user with mode 0700"
    return
  }
  [[ "$(stat -c '%u:%a' "${state_file}")" == "$(id -u):600" ]] || {
    fail "Recovery journal must be owned by the current user with mode 0600"
    return
  }

  document="$(jq -ec --arg region "${aws_region}" '
    if (
      type == "object" and
      keys == ["account", "branch", "branchCreated", "branchOwnership", "head", "pullRequestCreated", "pullRequestId", "pullRequestOwnership", "region", "repository", "runToken", "url"] and
      (.account | test("^[0-9]{12}$")) and
      .region == $region and
      (.repository | test("^[A-Za-z0-9._-]{1,100}$")) and
      (.runToken | test("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")) and
      .branch == ("pr-review-eval-" + .runToken) and
      (.head | test("^$|^[0-9a-f]{40}$")) and
      (.pullRequestId | test("^$|^[0-9]+$")) and
      (.branchOwnership == "none" or .branchOwnership == "uncertain" or .branchOwnership == "owned") and
      (.pullRequestOwnership == "none" or .pullRequestOwnership == "uncertain" or .pullRequestOwnership == "owned") and
      .branchCreated == (.branchOwnership == "owned") and
      .pullRequestCreated == (.pullRequestOwnership == "owned") and
      (if .branchOwnership == "owned" then .head != "" else true end) and
      (if .pullRequestOwnership == "owned" then .pullRequestId != "" else true end) and
      (.url | type == "string")
    ) then . else error("invalid recovery journal") end
  ' "${state_file}")" || {
    fail "Recovery journal has an invalid or incompatible payload"
    return
  }

  expected_account_id="$(jq -r '.account' <<<"${document}")"
  repository_name="$(jq -r '.repository' <<<"${document}")"
  run_token="$(jq -r '.runToken' <<<"${document}")"
  branch_name="$(jq -r '.branch' <<<"${document}")"
  branch_ownership="$(jq -r '.branchOwnership' <<<"${document}")"
  head_commit="$(jq -r '.head' <<<"${document}")"
  pull_request_id="$(jq -r '.pullRequestId' <<<"${document}")"
  pull_request_ownership="$(jq -r '.pullRequestOwnership' <<<"${document}")"
}

journal_state() {
  local branch_created=false
  local console_host
  local console_url=""
  local pull_request_created=false
  local temporary_state
  [[ -n "${state_root}" && -d "${state_root}" && -n "${state_file}" ]] || return 1
  [[ "${branch_ownership}" == "owned" ]] && branch_created=true
  [[ "${pull_request_ownership}" == "owned" ]] && pull_request_created=true
  console_host="$(console_host_for_region "${aws_region}")" || return 1
  if [[ -n "${pull_request_id}" ]]; then
    printf -v console_url \
      'https://%s/codesuite/codecommit/repositories/%s/pull-requests/%s?region=%s' \
      "${console_host}" "${repository_name}" "${pull_request_id}" "${aws_region}"
  fi
  temporary_state="$(mktemp "${state_root}/.fixture.XXXXXX")"
  if ! jq -n \
    --arg account "${expected_account_id}" \
    --arg branch "${branch_name}" \
    --arg branchOwnership "${branch_ownership}" \
    --arg head "${head_commit}" \
    --arg pullRequestId "${pull_request_id}" \
    --arg pullRequestOwnership "${pull_request_ownership}" \
    --arg region "${aws_region}" \
    --arg repository "${repository_name}" \
    --arg runToken "${run_token}" \
    --arg url "${console_url}" \
    --argjson branchCreated "${branch_created}" \
    --argjson pullRequestCreated "${pull_request_created}" \
    '{account: $account, region: $region, repository: $repository, runToken: $runToken, branch: $branch, branchCreated: $branchCreated, branchOwnership: $branchOwnership, head: $head, pullRequestId: $pullRequestId, pullRequestCreated: $pullRequestCreated, pullRequestOwnership: $pullRequestOwnership, url: $url}' \
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
  local role_identity

  stack_document="$(capture_aws cloudformation describe-stacks --stack-name "${stack_name}" --output json)" ||
    return 1
  repository_name="$(jq -er '.Stacks | if length == 1 then .[0].Outputs[] | select(.OutputKey == "CodeCommitRepository") | .OutputValue else empty end' <<<"${stack_document}" 2>/dev/null)" ||
    return 1
  fixture_role_arn="$(jq -er '.Stacks[0].Outputs[] | select(.OutputKey == "AwsRoleArn") | .OutputValue' <<<"${stack_document}" 2>/dev/null)" ||
    return 1
  stack_status="$(jq -er '.Stacks[0].StackStatus' <<<"${stack_document}" 2>/dev/null)" || return 1
  [[ "${stack_status}" =~ ^(CREATE|IMPORT|UPDATE|UPDATE_ROLLBACK)_COMPLETE$ ]] || return 1
  role_identity="$(fixture_role_identity "${fixture_role_arn}" "${aws_region}")" || return 1
  IFS=$'\t' read -r partition expected_account_id <<<"${role_identity}"

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

verify_recovery_pull_request() {
  local pull_request_document
  pull_request_document="$(capture_aws codecommit get-pull-request \
    --pull-request-id "${pull_request_id}" \
    --output json)" || return 1
  jq -e \
    --arg branch "${branch_name}" \
    --arg pullRequestId "${pull_request_id}" \
    --arg repository "${repository_name}" \
    --arg token "${run_token}" \
    '.pullRequest as $pr |
      ($pr.pullRequestStatus == "OPEN" or $pr.pullRequestStatus == "CLOSED") and
      $pr.pullRequestId == $pullRequestId and
      $pr.description == ("Disposable Control Center PR-review evaluation fixture " + $token + ".") and
      ($pr.pullRequestTargets | length) == 1 and
      $pr.pullRequestTargets[0].repositoryName == $repository and
      ($pr.pullRequestTargets[0].sourceReference == $branch or $pr.pullRequestTargets[0].sourceReference == ("refs/heads/" + $branch)) and
      ($pr.pullRequestTargets[0].destinationReference == "main" or $pr.pullRequestTargets[0].destinationReference == "refs/heads/main")' \
    <<<"${pull_request_document}" >/dev/null 2>&1 || return 1
  if jq -e '.pullRequest.pullRequestStatus == "CLOSED"' <<<"${pull_request_document}" >/dev/null 2>&1; then
    pull_request_ownership="none"
    journal_state || return 1
  fi
}

verify_recovery_branch() {
  local branch_document
  local recovered_head
  if branch_document="$("${aws_command[@]}" codecommit get-branch \
    --repository-name "${repository_name}" \
    --branch-name "${branch_name}" \
    --output json \
    --cli-error-format json 2>&1)"; then
    recovered_head="$(jq -er '.branch.commitId' <<<"${branch_document}" 2>/dev/null)" || return 1
    [[ "${recovered_head}" =~ ^[0-9a-f]{40}$ ]] || return 1
    [[ "${recovered_head}" == "${head_commit}" ]]
    return
  fi
  jq -e '.Code == "BranchDoesNotExistException"' <<<"${branch_document}" >/dev/null 2>&1 || return 1
  branch_ownership="none"
  journal_state
}

recover_fixture() {
  local journal_account
  local journal_repository
  local requested_state_file="$1"

  verify_cleanup_prerequisites || return 1
  load_recovery_state "${requested_state_file}" || return 1
  journal_account="${expected_account_id}"
  journal_repository="${repository_name}"
  verify_fixture_boundary || {
    fail "AWS account, stack, or repository did not match the recovery boundary"
    return
  }
  [[ "${expected_account_id}" == "${journal_account}" && "${repository_name}" == "${journal_repository}" ]] || {
    fail "Recovery journal does not belong to the verified fixture repository"
    return
  }

  if [[ "${branch_ownership}" == "uncertain" ]]; then
    fail "Branch ownership is uncertain; recovery state retained for operator resolution"
    return 1
  fi
  if [[ "${pull_request_ownership}" == "uncertain" ]]; then
    pull_request_id="$(find_created_pull_request)" || {
      fail "Unable to identify exactly one pull request owned by this recovery journal"
      return
    }
    pull_request_ownership="owned"
    journal_state || return 1
  fi
  if [[ "${pull_request_ownership}" == "owned" ]]; then
    verify_recovery_pull_request || {
      fail "Pull request identity no longer matches the recovery journal"
      return
    }
  fi
  if [[ "${branch_ownership}" == "owned" ]]; then
    verify_recovery_branch || {
      fail "Branch identity could not be verified for safe recovery"
      return
    }
  fi
  cleanup
}

cleanup() {
  local cleanup_failed=false

  if [[ "${pull_request_ownership}" == "uncertain" ]]; then
    cleanup_failed=true
  elif [[ "${pull_request_ownership}" == "owned" ]]; then
    if run_aws_quiet codecommit update-pull-request-status \
      --pull-request-id "${pull_request_id}" \
      --pull-request-status CLOSED; then
      pull_request_ownership="none"
      if ! journal_state; then
        printf 'Pull request closed, but its recovery journal could not be updated at %s\n' "${state_file}" >&2
        cleanup_failed=true
      fi
    else
      printf 'Pull request cleanup failed while closing the owned fixture\n' >&2
      cleanup_failed=true
    fi
  fi

  if [[ "${cleanup_failed}" == false && "${branch_ownership}" == "uncertain" ]]; then
    cleanup_failed=true
  elif [[ "${cleanup_failed}" == false && "${branch_ownership}" == "owned" ]]; then
    if ! verify_recovery_branch; then
      printf 'Branch cleanup refused because its exact head could not be verified\n' >&2
      cleanup_failed=true
    elif [[ "${branch_ownership}" == "owned" ]] && delete_branch_exact_head; then
      branch_ownership="none"
      if ! journal_state; then
        printf 'Branch deleted, but its recovery journal could not be updated at %s\n' "${state_file}" >&2
        cleanup_failed=true
      fi
    elif [[ "${branch_ownership}" == "owned" ]]; then
      printf 'Branch cleanup failed while deleting the exact fixture head\n' >&2
      cleanup_failed=true
    fi
  fi

  if [[ "${cleanup_failed}" == true ]]; then
    printf 'Cleanup incomplete; recovery state retained at %s\n' "${state_file}" >&2
    return 1
  fi
  if [[ -n "${state_root}" && -d "${state_root}" && "${state_file}" == "${state_root}/fixture.json" ]]; then
    if ! cleanup_stale_git_repositories; then
      printf 'Cleanup incomplete; isolated Git repository removal failed at %s\n' "${state_root}" >&2
      return 1
    fi
    if ! (
      shopt -s dotglob nullglob
      entries=("${state_root}"/*)
      if [[ -e "${state_file}" ]]; then
        [[ "${#entries[@]}" -eq 1 && "${entries[0]}" == "${state_file}" ]]
      else
        [[ "${#entries[@]}" -eq 0 ]]
      fi
    ); then
      printf 'Cleanup incomplete; recovery directory contains unexpected files at %s\n' "${state_root}" >&2
      return 1
    fi
    rm -f -- "${state_file}" || return 1
    rmdir -- "${state_root}" || return 1
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
  local create_branch_error
  local create_pull_request_output
  local fixture_commit
  local main_commit

  verify_cleanup_prerequisites || return 1
  command -v uuidgen >/dev/null 2>&1 || fail "uuidgen is required"
  run_token="$(make_run_token)"
  prepare_recovery_root || return 1
  state_root="$(mktemp -d "${recovery_root}/${run_token}.XXXXXX")"
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
  journal_state || {
    fail "Unable to initialize the recovery journal"
    return
  }
  printf 'RECOVERY %s\n' "${state_file}"

  main_commit="$(capture_aws codecommit get-branch \
    --repository-name "${repository_name}" \
    --branch-name main \
    --query branch.commitId \
    --output text)" || {
    fail "Unable to read the fixture main branch"
    return
  }
  [[ "${main_commit}" =~ ^[0-9a-f]{40}$ ]] || {
    fail "Fixture main branch returned an invalid commit identity"
    return
  }

  branch_ownership="uncertain"
  if ! journal_state; then
    branch_ownership="none"
    return 1
  fi
  if create_branch_error="$("${aws_command[@]}" codecommit create-branch \
    --repository-name "${repository_name}" \
    --branch-name "${branch_name}" \
    --commit-id "${main_commit}" \
    --cli-error-format json 2>&1 >/dev/null)"; then
    branch_ownership="owned"
    head_commit="${main_commit}"
  elif jq -e '.Code == "BranchNameExistsException"' <<<"${create_branch_error}" >/dev/null 2>&1; then
    branch_ownership="none"
    journal_state || return 1
    fail "Fixture branch name collided with an existing branch"
    return 1
  else
    fail "Branch creation outcome is uncertain; recovery state retained at ${state_file}"
    return 1
  fi
  journal_state || {
    fail "Unable to persist recovery state after branch creation"
    return
  }

  fixture_commit="$(capture_aws codecommit put-file \
    --repository-name "${repository_name}" \
    --branch-name "${branch_name}" \
    --file-path eval/idempotency-retry.ts \
    --file-content "fileb://${fixture_file}" \
    --parent-commit-id "${main_commit}" \
    --commit-message "Add retry helper eval fixture" \
    --query commitId \
    --output text)" || {
    fail "Unable to write the evaluation change to the fixture branch"
    return
  }
  [[ "${fixture_commit}" =~ ^[0-9a-f]{40}$ ]] || {
    fail "Fixture update returned an invalid commit identity"
    return
  }
  head_commit="${fixture_commit}"
  journal_state || {
    fail "Unable to persist recovery state after the fixture update"
    return
  }

  pull_request_ownership="uncertain"
  if ! journal_state; then
    pull_request_ownership="none"
    fail "Unable to persist recovery state before pull request creation"
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
      pull_request_id="$(find_created_pull_request)" || {
        fail "Pull request creation returned an invalid identity and could not be reconciled"
        return
      }
    fi
  else
    pull_request_id="$(find_created_pull_request)" || {
      fail "Pull request creation outcome is uncertain; recovery state retained at ${state_file}"
      return
    }
  fi
  [[ "${pull_request_id}" =~ ^[0-9]+$ ]] || {
    fail "Pull request creation returned an invalid identity"
    return
  }
  pull_request_ownership="owned"
  journal_state || {
    fail "Unable to persist recovery state after pull request creation"
    return
  }

  printf 'READY %s\n' "${state_file}"
}

main() {
  case "${1:-create}" in
    create)
      [[ "$#" -le 1 ]] || {
        fail "Usage: pr-review-eval.sh [create | recover JOURNAL]"
        return
      }
      create_fixture
      while IFS= read -r command; do
        [[ "${command}" == "stop" ]] && return
      done
      ;;
    recover)
      [[ "$#" -eq 2 ]] || {
        fail "Usage: pr-review-eval.sh recover JOURNAL"
        return
      }
      recover_fixture "$2"
      printf 'RECOVERED %s\n' "$2"
      ;;
    *) fail "Usage: pr-review-eval.sh [create | recover JOURNAL]" ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
