#!/usr/bin/env bash

set -euo pipefail

test_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly test_root
repository_root="$(cd "${test_root}/../.." && pwd)"
readonly repository_root
readonly probe_workflow="${repository_root}/.github/workflows/control-center-live-aws-probe.yml"
probe_test_root="$(mktemp -d)"
readonly probe_test_root
readonly probe_script="${probe_test_root}/probe.sh"
trap 'rm -rf -- "${probe_test_root}"' EXIT

awk '
  $0 == "      - name: Probe stable read-only fixtures" {
    target = 1
    next
  }
  target && $0 == "        run: |" {
    capture = 1
    next
  }
  capture && /^          / {
    sub(/^          /, "")
    print
    next
  }
  capture && $0 == "" {
    print
    next
  }
  capture {
    exit
  }
' "${probe_workflow}" >"${probe_script}"

if [[ ! -s "${probe_script}" ]]; then
  printf '%s\n' "AWS probe shell block could not be extracted" >&2
  exit 1
fi

mock_pipeline_definition() {
  jq -n '{
    pipeline: {
      stages: [
        {
          name: "Source",
          actions: [{
            name: "ReadFixture",
            actionTypeId: {
              category: "Source",
              owner: "AWS",
              provider: "CodeCommit",
              version: "1"
            },
            configuration: {
              RepositoryName: "fixture-repository",
              BranchName: "main",
              PollForSourceChanges: "false"
            },
            runOrder: 1
          }]
        },
        {
          name: "Approval",
          actions: [{
            name: "ConfirmFixture",
            actionTypeId: {
              category: "Approval",
              owner: "AWS",
              provider: "Manual",
              version: "1"
            },
            runOrder: 1
          }]
        }
      ]
    }
  }' |
    case "${probe_scenario}" in
      foreign-pipeline-repository)
        jq '.pipeline.stages[0].actions[0].configuration.RepositoryName = "foreign-repository"'
        ;;
      non-main-pipeline-source)
        jq '.pipeline.stages[0].actions[0].configuration.BranchName = "release"'
        ;;
      pipeline-source-polling-enabled)
        jq '.pipeline.stages[0].actions[0].configuration.PollForSourceChanges = "true"'
        ;;
      *)
        jq '.'
        ;;
    esac
}

aws() {
  if [[ "${probe_scenario}" == "provider-stderr" ]]; then
    printf '%s\n' \
      "provider-sentinel account=999988887777 arn=arn:aws:iam::999988887777:role/private repository=customer-records" \
      >&2
    return 1
  fi
  if [[ "$*" == "sts get-caller-identity --query Account --output text" ]]; then
    if [[ "${probe_scenario}" == "wrong-account" ]]; then
      printf '999999999999\n'
    else
      printf '123456789012\n'
    fi
    return
  fi
  if [[ "$*" == *"codepipeline get-pipeline --name"* ]]; then
    mock_pipeline_definition
    return
  fi
  if [[ "$*" == *"codecommit get-repository"* ||
    "$*" == *"codepipeline get-pipeline-state"* ||
    "$*" == *"codepipeline get-pipeline-execution"* ]]; then
    return
  fi
  if [[ "$*" == *"codecommit list-pull-requests"* ]]; then
    if [[ "${probe_scenario}" == "unrelated-pr" ]]; then
      printf 'pr-unrelated\n'
    else
      printf 'pr-unrelated\tpr-stable\n'
    fi
    return
  fi
  if [[ "$*" == *"codecommit get-pull-request --pull-request-id pr-unrelated"* ]]; then
    printf 'refs/heads/unrelated\trefs/heads/main\tunrelated-commit\tmain-commit\n'
    return
  fi
  if [[ "$*" == *"codecommit get-pull-request --pull-request-id pr-stable"* ]]; then
    printf 'refs/heads/fixture-change\trefs/heads/main\tfixture-commit\tmain-commit\n'
    return
  fi
  if [[ "$*" == *"codecommit get-differences"*"length(differences)"* ]]; then
    if [[ "${probe_scenario}" == "unexpected-diff-count" ]]; then
      printf '2\n'
    else
      printf '1\n'
    fi
    return
  fi
  if [[ "$*" == *"codecommit get-differences"*"afterBlob.path"* ]]; then
    if [[ "${probe_scenario}" == "unexpected-diff-path" ]]; then
      printf 'operator.txt\n'
    else
      printf 'fixture.txt\n'
    fi
    return
  fi
  if [[ "$*" == *"codepipeline list-pipeline-executions"* ]]; then
    if [[ "${probe_scenario}" == "failed-execution" ]]; then
      printf 'None\n'
    elif [[ "${probe_scenario}" == "empty-execution" ]]; then
      printf ''
    else
      printf 'succeeded-execution\n'
    fi
    return
  fi
  if [[ "$*" == *"codepipeline list-action-executions"*"actionName=='ReadFixture'"* ]]; then
    if [[ "${probe_scenario}" == "missing-source-action" ]]; then
      printf '0\n'
    else
      printf '1\n'
    fi
    return
  fi
  if [[ "$*" == *"codepipeline list-action-executions"*"actionName=='ConfirmFixture'"* ]]; then
    if [[ "${probe_scenario}" == "missing-approval-action" ]]; then
      printf '0\n'
    else
      printf '1\n'
    fi
    return
  fi

  printf '%s\n' "Unexpected mocked AWS probe command: $*" >&2
  return 1
}
export -f mock_pipeline_definition
export -f aws
export FIXTURE_ROLE_ARN="arn:aws:iam::123456789012:role/control-center-live"
export FIXTURE_REPOSITORY="fixture-repository"
export FIXTURE_PIPELINE="fixture-pipeline"

probe_scenario="success"
export probe_scenario
if FIXTURE_ROLE_ARN="malformed" bash "${probe_script}" >/dev/null 2>&1; then
  printf '%s\n' "AWS probe must reject a malformed role ARN" >&2
  exit 1
fi
if FIXTURE_ROLE_ARN="arn:unknown:iam::123456789012:role/control-center-live" \
  bash "${probe_script}" >/dev/null 2>&1; then
  printf '%s\n' "AWS probe must reject an unknown AWS partition" >&2
  exit 1
fi
if FIXTURE_ROLE_ARN="arn:aws-cn:iam::123456789012:role/control-center-live" \
  bash "${probe_script}" >/dev/null 2>&1; then
  printf '%s\n' "AWS probe must reject aws-cn until the China STS audience is supported" >&2
  exit 1
fi

probe_scenario="wrong-account"
export probe_scenario
if bash "${probe_script}" >/dev/null 2>&1; then
  printf '%s\n' "AWS probe must reject an unexpected STS account" >&2
  exit 1
fi

probe_scenario="provider-stderr"
export probe_scenario
provider_failure_output=""
if provider_failure_output="$(bash "${probe_script}" 2>&1)"; then
  printf '%s\n' "AWS probe must fail when a provider command fails" >&2
  exit 1
fi
if [[ "${provider_failure_output}" == *"provider-sentinel"* ||
  "${provider_failure_output}" == *"999988887777"* ||
  "${provider_failure_output}" == *"customer-records"* ]]; then
  printf '%s\n' "AWS probe must discard provider stderr" >&2
  exit 1
fi
if [[ "${provider_failure_output}" != *"Control Center live AWS probe failed (sts-identity)"* ]]; then
  printf '%s\n' "AWS probe must emit a fixed provider failure diagnostic" >&2
  exit 1
fi

probe_scenario="unrelated-pr"
export probe_scenario
if bash "${probe_script}" >/dev/null 2>&1; then
  printf '%s\n' "AWS probe must reject an unrelated open pull request" >&2
  exit 1
fi

for probe_scenario in \
  unexpected-diff-count \
  unexpected-diff-path \
  failed-execution \
  empty-execution \
  foreign-pipeline-repository \
  missing-source-action \
  missing-approval-action \
  non-main-pipeline-source \
  pipeline-source-polling-enabled; do
  export probe_scenario
  if bash "${probe_script}" >/dev/null 2>&1; then
    printf '%s\n' "AWS probe rejection scenario ${probe_scenario} must fail closed" >&2
    exit 1
  fi
done

probe_scenario="success"
export probe_scenario
bash "${probe_script}" >/dev/null

printf '%s\n' "Control Center live AWS probe contract is valid"
