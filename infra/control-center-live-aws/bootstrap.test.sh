#!/usr/bin/env bash

set -euo pipefail

test_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly test_root

# shellcheck source=bootstrap.sh
source "${test_root}/bootstrap.sh"
original_find_github_oidc_provider="$(declare -f find_github_oidc_provider)"
readonly original_find_github_oidc_provider

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

stack_exists() {
  return 0
}
stack_existing_oidc_parameter() {
  printf ''
}
stack_owned_oidc_provider_arn() {
  printf 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com'
}
aws() {
  if [[ "$*" == *"--query Url"* ]]; then
    printf 'token.actions.githubusercontent.com\n'
  elif [[ "$*" == *"contains(ClientIDList, 'sts.amazonaws.com')"* ]]; then
    printf 'True\n'
  else
    fail "unexpected compatibility-probe command: $*"
  fi
}
find_github_oidc_provider() {
  fail "stack-owned provider resolution must not rediscover an external provider"
}

owned_parameter="$(resolve_existing_oidc_provider_parameter)"
[[ -z "${owned_parameter}" ]] ||
  fail "a repeated stack-owned deployment must preserve an empty external-provider parameter"

stack_existing_oidc_parameter() {
  printf 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com'
}
external_parameter="$(resolve_existing_oidc_provider_parameter)"
[[ "${external_parameter}" == \
  "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" ]] ||
  fail "a repeated external-provider deployment must preserve its ARN"

stack_exists() {
  return 1
}
find_github_oidc_provider() {
  printf 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com'
}
first_deployment_parameter="$(resolve_existing_oidc_provider_parameter)"
[[ "${first_deployment_parameter}" == \
  "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" ]] ||
  fail "a first deployment must reuse a compatible external provider"
eval "${original_find_github_oidc_provider}"

aws() {
  if [[ "$*" == *"--query Url"* ]]; then
    printf 'token.actions.githubusercontent.com\n'
  elif [[ "$*" == *"contains(ClientIDList, 'sts.amazonaws.com')"* ]]; then
    printf 'False\n'
  else
    fail "unexpected compatibility-probe command: $*"
  fi
}
if provider_is_compatible \
  "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"; then
  fail "a GitHub provider without the STS audience must be rejected"
fi

fixture_test_root="$(mktemp -d)"
readonly fixture_test_root
trap 'rm -rf -- "${fixture_test_root}"' EXIT
readonly fixture_test_change="${fixture_test_root}/change.txt"
readonly fixture_test_log="${fixture_test_root}/aws.log"
printf '%s\n' "${expected_change_content}" >"${fixture_test_change}"

aws() {
  printf '%s\n' "$*" >>"${fixture_test_log}"
  if [[ "$*" == *"codecommit get-branch"* ]]; then
    if [[ "${fixture_scenario}" == "interrupted" ]]; then
      printf 'main-commit\n'
    else
      printf 'fixture-commit\n'
    fi
  elif [[ "$*" == *"codecommit put-file"* ]]; then
    printf 'fixture-commit\n'
  elif [[ "$*" == *"codecommit get-file"* ]]; then
    if [[ "${fixture_scenario}" == "drifted" ]]; then
      printf '%s' "operator content" | base64
    else
      printf '%s' "${expected_change_content}" | base64
    fi
  elif [[ "$*" == *"codecommit get-differences"*"length(differences)"* ]]; then
    printf '1\n'
  elif [[ "$*" == *"codecommit get-differences"*"afterBlob.path"* ]]; then
    printf 'fixture.txt\n'
  else
    fail "unexpected fixture-reconciliation command: $*"
  fi
}

fixture_scenario="interrupted"
: >"${fixture_test_log}"
interrupted_commit="$(
  ensure_fixture_change fixture-repository main-commit "${fixture_test_change}"
)"
[[ "${interrupted_commit}" == "fixture-commit" ]] ||
  fail "an interrupted branch seed must finish the deterministic commit"
grep -Fq "codecommit put-file" "${fixture_test_log}" ||
  fail "an interrupted branch seed must write the fixture change"

fixture_scenario="complete"
: >"${fixture_test_log}"
complete_commit="$(ensure_fixture_change fixture-repository main-commit "${fixture_test_change}")"
[[ "${complete_commit}" == "fixture-commit" ]] ||
  fail "an already-complete fixture branch must be retained"
if grep -Fq "codecommit put-file" "${fixture_test_log}"; then
  fail "an already-complete fixture branch must not be rewritten"
fi

fixture_scenario="drifted"
: >"${fixture_test_log}"
if ensure_fixture_change fixture-repository main-commit "${fixture_test_change}" \
  >/dev/null 2>&1; then
  fail "operator-authored fixture drift must fail closed"
fi

aws() {
  if [[ "$*" == *"cloudformation describe-stack-resource"*"LiveIntegrationRole"* ]]; then
    printf 'live-role\n'
  elif [[ "$*" == *"cloudformation describe-stack-resource"*"PipelineRole"* ]]; then
    printf 'pipeline-role\n'
  elif [[ "$*" == *"cloudformation describe-stack-resource"*"ArtifactBucket"* ]]; then
    printf 'fixture-artifact-bucket\n'
  elif [[ "$*" == *"cloudformation describe-stack-resource"*"GitHubOidcProvider"* ]]; then
    printf 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com\n'
  elif [[ "$*" == *"iam list-attached-role-policies"*"live-role"* ]]; then
    if [[ "${iam_scenario}" == "attached-managed-policy" ]]; then
      printf '["arn:aws:iam::aws:policy/AdministratorAccess"]\n'
    else
      printf '[]\n'
    fi
  elif [[ "$*" == *"iam list-attached-role-policies"*"pipeline-role"* ]]; then
    printf '[]\n'
  elif [[ "$*" == *"iam list-role-policies"*"live-role"* ]]; then
    if [[ "${iam_scenario}" == "extra-inline-policy" ]]; then
      printf '["ControlCenterLiveReadOnly","OperatorOverride"]\n'
    else
      printf '["ControlCenterLiveReadOnly"]\n'
    fi
  elif [[ "$*" == *"iam list-role-policies"*"pipeline-role"* ]]; then
    printf '["FixturePipelineAccess"]\n'
  elif [[ "$*" == *"iam get-role "*"live-role"* ]]; then
    if [[ "${iam_scenario}" == "widened-live-trust" ]]; then
      live_role_trust_document \
        "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" |
        jq '.Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] = "repo:other/repository:*"'
    else
      live_role_trust_document \
        "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    fi
  elif [[ "$*" == *"iam get-role "*"pipeline-role"* ]]; then
    if [[ "${iam_scenario}" == "widened-pipeline-trust" ]]; then
      pipeline_role_trust_document |
        jq '.Statement[0].Principal.Service = "*"'
    else
      pipeline_role_trust_document
    fi
  elif [[ "$*" == *"iam get-role-policy"*"live-role"* ]]; then
    if [[ "${iam_scenario}" == "widened-inline-policy" ]]; then
      live_role_policy_document \
        "arn:aws:codecommit:eu-central-1:123456789012:fixture-repository" \
        "arn:aws:codepipeline:eu-central-1:123456789012:fixture-pipeline" |
        jq '.Statement[2].Action += ["codecommit:DeleteRepository"]'
    else
      live_role_policy_document \
        "arn:aws:codecommit:eu-central-1:123456789012:fixture-repository" \
        "arn:aws:codepipeline:eu-central-1:123456789012:fixture-pipeline"
    fi
  elif [[ "$*" == *"iam get-role-policy"*"pipeline-role"* ]]; then
    if [[ "${iam_scenario}" == "widened-pipeline-inline-policy" ]]; then
      pipeline_role_policy_document \
        "arn:aws:codecommit:eu-central-1:123456789012:fixture-repository" \
        "arn:aws:s3:::fixture-artifact-bucket" |
        jq '.Statement[2].Action += ["s3:DeleteObject"]'
    else
      pipeline_role_policy_document \
        "arn:aws:codecommit:eu-central-1:123456789012:fixture-repository" \
        "arn:aws:s3:::fixture-artifact-bucket"
    fi
  else
    fail "unexpected deployed-IAM verification command: $*"
  fi
}

iam_scenario="success"
verify_deployed_iam \
  "arn:aws:iam::123456789012:role/live-role" \
  fixture-repository \
  fixture-pipeline \
  ""
if verify_deployed_iam \
  "arn:aws-cn:iam::123456789012:role/live-role" \
  fixture-repository \
  fixture-pipeline \
  "" >/dev/null 2>&1; then
  fail "deployed IAM verification must reject aws-cn until the China STS audience is supported"
fi

for rejected_iam_scenario in \
  attached-managed-policy \
  extra-inline-policy \
  widened-live-trust \
  widened-pipeline-trust \
  widened-inline-policy \
  widened-pipeline-inline-policy; do
  iam_scenario="${rejected_iam_scenario}"
  if verify_deployed_iam \
    "arn:aws:iam::123456789012:role/live-role" \
    fixture-repository \
    fixture-pipeline \
    "" >/dev/null 2>&1; then
    fail "deployed IAM drift scenario ${rejected_iam_scenario} must fail closed"
  fi
done

stack_resource_physical_id() {
  [[ "$1" == "ArtifactBucket" ]] ||
    fail "unexpected bucket logical resource: $1"
  printf 'fixture-artifact-bucket\n'
}

aws() {
  if [[ "${bucket_scenario}" == "unreadable" ]]; then
    return 1
  elif [[ "$*" == *"s3api get-public-access-block"* ]]; then
    jq -n '{
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true
    }' |
      if [[ "${bucket_scenario}" == "public-access" ]]; then
        jq '.BlockPublicPolicy = false'
      else
        jq '.'
      fi
  elif [[ "$*" == *"s3api get-bucket-encryption"* ]]; then
    jq -n '{
      Rules: [{
        ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" }
      }]
    }' |
      if [[ "${bucket_scenario}" == "encryption" ]]; then
        jq '.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm = "aws:kms"'
      else
        jq '.'
      fi
  elif [[ "$*" == *"s3api get-bucket-lifecycle-configuration"* ]]; then
    jq -n '{
      Rules: [{
        ID: "ExpireFixtureArtifacts",
        Status: "Enabled",
        Expiration: { Days: 1 },
        NoncurrentVersionExpiration: { NoncurrentDays: 6 }
      }]
    }' |
      if [[ "${bucket_scenario}" == "lifecycle" ]]; then
        jq '.Rules[0].Expiration.Days = 7'
      elif [[ "${bucket_scenario}" == "lifecycle-filter" ]]; then
        jq '.Rules[0].Filter = { Prefix: "excluded/" }'
      elif [[ "${bucket_scenario}" == "lifecycle-empty-filter" ]]; then
        jq '.Rules[0].Filter = { Prefix: "" }'
      else
        jq '.'
      fi
  elif [[ "$*" == *"s3api get-bucket-ownership-controls"* ]]; then
    jq -n '{
      Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }]
    }' |
      if [[ "${bucket_scenario}" == "ownership" ]]; then
        jq '.Rules[0].ObjectOwnership = "ObjectWriter"'
      else
        jq '.'
      fi
  elif [[ "$*" == *"s3api get-bucket-versioning"* ]]; then
    if [[ "${bucket_scenario}" == "versioning" ]]; then
      printf '{}\n'
    else
      printf '{"Status":"Enabled"}\n'
    fi
  elif [[ "$*" == *"s3api get-bucket-policy"* ]]; then
    bucket_policy_document "arn:aws:s3:::fixture-artifact-bucket" |
      if [[ "${bucket_scenario}" == "policy" ]]; then
        jq '.Statement[0].Condition.Bool["aws:SecureTransport"] = "true"'
      else
        jq '.'
      fi
  else
    fail "unexpected deployed-bucket verification command: $*"
  fi
}

bucket_scenario="success"
verify_deployed_bucket "arn:aws:iam::123456789012:role/live-role"
bucket_scenario="lifecycle-empty-filter"
verify_deployed_bucket "arn:aws:iam::123456789012:role/live-role"

for rejected_bucket_scenario in \
  encryption \
  lifecycle \
  lifecycle-filter \
  ownership \
  policy \
  public-access \
  unreadable \
  versioning; do
  bucket_scenario="${rejected_bucket_scenario}"
  if verify_deployed_bucket "arn:aws:iam::123456789012:role/live-role" >/dev/null 2>&1; then
    fail "deployed bucket drift scenario ${rejected_bucket_scenario} must fail closed"
  fi
done

deployed_pipeline_definition() {
  jq -n '{
    pipeline: {
      version: 7,
      roleArn: "arn:aws:iam::123456789012:role/fixture-pipeline-role",
      artifactStore: {
        type: "S3",
        location: "fixture-artifact-bucket"
      },
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
    case "${pipeline_definition_scenario}" in
      foreign-repository)
        jq '.pipeline.stages[0].actions[0].configuration.RepositoryName = "foreign-repository"'
        ;;
      non-main-branch)
        jq '.pipeline.stages[0].actions[0].configuration.BranchName = "release"'
        ;;
      polling-enabled)
        jq '.pipeline.stages[0].actions[0].configuration.PollForSourceChanges = "true"'
        ;;
      missing-approval)
        jq '.pipeline.stages[1].actions = []'
        ;;
      invalid-version)
        jq '.pipeline.version = 0'
        ;;
      foreign-role)
        jq '.pipeline.roleArn = "arn:aws:iam::999988887777:role/foreign-pipeline-role"'
        ;;
      foreign-artifact-bucket)
        jq '.pipeline.artifactStore.location = "foreign-artifact-bucket"'
        ;;
      *)
        jq '.'
        ;;
    esac
}

aws() {
  if [[ "$*" == *"codepipeline get-pipeline"* ]]; then
    deployed_pipeline_definition
    return
  fi
  fail "unexpected deployed-pipeline verification command: $*"
}

pipeline_definition_scenario="success"
[[ "$(
  verify_deployed_pipeline \
    fixture-repository \
    fixture-pipeline \
    arn:aws:iam::123456789012:role/fixture-pipeline-role \
    fixture-artifact-bucket
)" == "7" ]] ||
  fail "deployed pipeline verification must return the attested current version"

for rejected_pipeline_definition_scenario in \
  foreign-repository \
  non-main-branch \
  polling-enabled \
  missing-approval \
  invalid-version \
  foreign-role \
  foreign-artifact-bucket; do
  pipeline_definition_scenario="${rejected_pipeline_definition_scenario}"
  if verify_deployed_pipeline \
    fixture-repository \
    fixture-pipeline \
    arn:aws:iam::123456789012:role/fixture-pipeline-role \
    fixture-artifact-bucket >/dev/null 2>&1; then
    fail "deployed pipeline drift scenario ${rejected_pipeline_definition_scenario} must fail closed"
  fi
done

aws() {
  if [[ "$*" == *"iam list-open-id-connect-providers"* ]]; then
    return 1
  fi
  fail "unexpected failed-provider-list command: $*"
}
if find_github_oidc_provider >/dev/null 2>&1; then
  fail "OIDC provider discovery must fail when the provider list cannot be read"
fi

aws() {
  if [[ "$*" == *"codecommit list-pull-requests"* ]]; then
    return 1
  fi
  fail "unexpected failed-pull-request-list command: $*"
}
if find_stable_pull_request fixture-repository >/dev/null 2>&1; then
  fail "pull request discovery must fail when the open pull request list cannot be read"
fi

aws() {
  if [[ "$*" == *"codecommit list-pull-requests"* ]]; then
    printf 'pr-stable\n'
    return
  fi
  if [[ "$*" == *"codecommit get-pull-request"* ]]; then
    return 1
  fi
  fail "unexpected failed-pull-request-read command: $*"
}
if find_stable_pull_request fixture-repository >/dev/null 2>&1; then
  fail "pull request discovery must fail when a listed pull request cannot be read"
fi

sleep() {
  :
}

aws() {
  printf '%s\n' "$*" >>"${fixture_test_log}"
  if [[ "$*" == *"codepipeline list-pipeline-executions"* ]]; then
    if [[ "${pipeline_scenario}" == "unreadable-history" ]]; then
      return 1
    elif [[ "${pipeline_scenario}" == "success-within-five" ]]; then
      printf 'existing-success\n'
    elif [[ "${pipeline_scenario}" == "empty-history" ]]; then
      printf ''
    else
      printf 'None\n'
    fi
  elif [[ "$*" == *"codepipeline start-pipeline-execution"* ]]; then
    if [[ "${pipeline_scenario}" == "start-failure" ]]; then
      return 1
    fi
    printf 'fresh-success\n'
  elif [[ "$*" == *"codepipeline get-pipeline-state"* ]]; then
    if [[ "$*" == *"stageStates[?stageName=='Approval' && latestExecution.pipelineExecutionId=='fresh-success'] | [0].actionStates[?actionName=='ConfirmFixture'] | [0].latestExecution.token"* ]]; then
      printf 'approval-token\n'
    else
      printf 'stale-approval-token\n'
    fi
  elif [[ "$*" == *"codepipeline put-approval-result"* ]]; then
    if [[ "${pipeline_scenario}" == "approval-failure" ]]; then
      return 1
    fi
    printf '{}\n'
  elif [[ "$*" == *"codepipeline get-pipeline-execution"* ]]; then
    printf 'Succeeded\n'
  else
    fail "unexpected pipeline-history command: $*"
  fi
}

pipeline_scenario="success-within-five"
: >"${fixture_test_log}"
recent_execution="$(ensure_recent_successful_pipeline_execution fixture-pipeline 7)"
[[ "${recent_execution}" == "existing-success" ]] ||
  fail "a success within the five-execution probe bound must be retained"
grep -Fq -- "--no-paginate --max-results 5" "${fixture_test_log}" ||
  fail "bootstrap history lookup must use the same five-execution bound as the live probe"
grep -Fq "pipelineVersion==\`7\`" "${fixture_test_log}" ||
  fail "bootstrap history lookup must bind success to the attested current pipeline version"
if grep -Fq "codepipeline start-pipeline-execution" "${fixture_test_log}"; then
  fail "a success within the five-execution probe bound must not start a new execution"
fi

for pipeline_scenario in stale-version-success old-success-after-five-failures empty-history; do
  : >"${fixture_test_log}"
  recent_execution="$(ensure_recent_successful_pipeline_execution fixture-pipeline 7)"
  [[ "${recent_execution}" == "fresh-success" ]] ||
    fail "history scenario ${pipeline_scenario} must create a fresh successful execution"
  grep -Fq "codepipeline start-pipeline-execution" "${fixture_test_log}" ||
    fail "history scenario ${pipeline_scenario} must start a fresh execution"
  grep -Fq "codepipeline put-approval-result" "${fixture_test_log}" ||
    fail "history scenario ${pipeline_scenario} must approve the fresh execution"
  grep -Fq -- "--token approval-token" "${fixture_test_log}" ||
    fail "history scenario ${pipeline_scenario} must approve only its own execution"
done

pipeline_scenario="unreadable-history"
: >"${fixture_test_log}"
if ensure_recent_successful_pipeline_execution fixture-pipeline 7 >/dev/null 2>&1; then
  fail "an unreadable pipeline history must fail closed"
fi
if grep -Fq "codepipeline start-pipeline-execution" "${fixture_test_log}"; then
  fail "an unreadable pipeline history must not create a replacement execution"
fi

for pipeline_scenario in start-failure approval-failure; do
  : >"${fixture_test_log}"
  if pipeline_failure="$(
    ensure_recent_successful_pipeline_execution fixture-pipeline 7 2>&1
  )"; then
    fail "pipeline write scenario ${pipeline_scenario} must fail immediately"
  fi
  if [[ "${pipeline_scenario}" == "start-failure" ]]; then
    [[ "${pipeline_failure}" == "Unable to start a fixture pipeline execution" ]] ||
      fail "a start failure must report its fixed write diagnostic"
    if grep -Fq "codepipeline get-pipeline-state" "${fixture_test_log}"; then
      fail "a start failure must not enter approval polling"
    fi
  else
    [[ "${pipeline_failure}" == "Unable to approve the fixture pipeline execution" ]] ||
      fail "an approval failure must report its fixed write diagnostic"
    if grep -Fq "codepipeline get-pipeline-execution" "${fixture_test_log}"; then
      fail "an approval failure must not enter execution polling"
    fi
  fi
done

aws() {
  local action_history_attempt

  printf '%s\n' "$*" >>"${fixture_test_log}"
  if [[ "$*" != *"codepipeline list-action-executions"* ]]; then
    fail "unexpected action-history command: $*"
  fi
  action_history_attempt="$(grep -Fc "codepipeline list-action-executions" "${fixture_test_log}")"
  if [[ "${action_history_scenario}" == "eventually-consistent" &&
    "${action_history_attempt}" -ge 2 ]]; then
    printf '1\t1\n'
  else
    printf '0\t0\n'
  fi
}

action_history_scenario="eventually-consistent"
: >"${fixture_test_log}"
wait_for_pipeline_action_history fixture-pipeline fresh-success
[[ "$(grep -Fc "codepipeline list-action-executions" "${fixture_test_log}")" -eq 2 ]] ||
  fail "eventually consistent action history must be retried until both actions are visible"

action_history_scenario="never-consistent"
: >"${fixture_test_log}"
if wait_for_pipeline_action_history fixture-pipeline fresh-success >/dev/null 2>&1; then
  fail "incomplete action history must fail after the bounded polling window"
fi
[[ "$(grep -Fc "codepipeline list-action-executions" "${fixture_test_log}")" -eq 12 ]] ||
  fail "incomplete action history must stop at the twelve-attempt bound"

printf '%s\n' "Control Center live AWS bootstrap contract is valid"
