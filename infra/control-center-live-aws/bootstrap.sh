#!/usr/bin/env bash

set -euo pipefail

readonly stack_name="${CONTROL_CENTER_LIVE_AWS_STACK_NAME:-control-center-live-fixtures}"
readonly aws_region="${CONTROL_CENTER_LIVE_AWS_REGION:-eu-central-1}"
script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly script_root
readonly expected_main_content="Control Center live fixture"
readonly expected_change_content="Control Center live fixture change"

aws_region_command=(aws --region "${aws_region}")
temporary_root=""

cleanup() {
  if [[ -n "${temporary_root}" && -d "${temporary_root}" ]]; then
    rm -rf -- "${temporary_root}"
  fi
}

stack_exists() {
  "${aws_region_command[@]}" cloudformation describe-stacks \
    --stack-name "${stack_name}" \
    --query 'Stacks[0].StackId' \
    --output text >/dev/null 2>&1
}

stack_existing_oidc_parameter() {
  "${aws_region_command[@]}" cloudformation describe-stacks \
    --stack-name "${stack_name}" \
    --query "Stacks[0].Parameters[?ParameterKey=='ExistingGitHubOidcProviderArn'].ParameterValue | [0]" \
    --output text
}

stack_owned_oidc_provider_arn() {
  "${aws_region_command[@]}" cloudformation describe-stack-resource \
    --stack-name "${stack_name}" \
    --logical-resource-id GitHubOidcProvider \
    --query 'StackResourceDetail.PhysicalResourceId' \
    --output text
}

provider_is_compatible() {
  local provider_arn="$1"
  local provider_url
  local has_sts_audience

  provider_url="$(
    aws iam get-open-id-connect-provider \
      --open-id-connect-provider-arn "${provider_arn}" \
      --query Url \
      --output text
  )"
  has_sts_audience="$(
    aws iam get-open-id-connect-provider \
      --open-id-connect-provider-arn "${provider_arn}" \
      --query "contains(ClientIDList, 'sts.amazonaws.com')" \
      --output text
  )"

  [[ "${provider_url}" == "token.actions.githubusercontent.com" &&
    "${has_sts_audience}" == "True" ]]
}

find_github_oidc_provider() {
  local provider_arn
  local provider_arns
  local provider_url

  if ! provider_arns="$(
    aws iam list-open-id-connect-providers \
      --query 'OpenIDConnectProviderList[].Arn' \
      --output text
  )"; then
    printf '%s\n' "Unable to list existing OIDC providers" >&2
    return 1
  fi

  while IFS= read -r provider_arn; do
    [[ -n "${provider_arn}" ]] || continue
    if ! provider_url="$(
      aws iam get-open-id-connect-provider \
        --open-id-connect-provider-arn "${provider_arn}" \
        --query Url \
        --output text
    )"; then
      printf '%s\n' "Unable to inspect existing OIDC provider" >&2
      return 1
    fi
    [[ "${provider_url}" == "token.actions.githubusercontent.com" ]] || continue
    if ! provider_is_compatible "${provider_arn}"; then
      printf '%s\n' "Existing GitHub OIDC provider lacks the sts.amazonaws.com audience" >&2
      return 1
    fi
    printf '%s' "${provider_arn}"
    return
  done <<<"$(tr '\t' '\n' <<<"${provider_arns}")"
}

resolve_existing_oidc_provider_parameter() {
  local existing_parameter
  local owned_provider_arn

  if ! stack_exists; then
    find_github_oidc_provider
    return
  fi

  existing_parameter="$(stack_existing_oidc_parameter)"
  if [[ "${existing_parameter}" == "None" ]]; then
    printf '%s\n' "Existing stack is missing its OIDC ownership parameter" >&2
    return 1
  fi
  if [[ -n "${existing_parameter}" ]]; then
    if ! provider_is_compatible "${existing_parameter}"; then
      printf '%s\n' "Stack external OIDC provider is absent or incompatible" >&2
      return 1
    fi
    printf '%s' "${existing_parameter}"
    return
  fi

  if ! owned_provider_arn="$(stack_owned_oidc_provider_arn)" ||
    ! provider_is_compatible "${owned_provider_arn}"; then
    printf '%s\n' "Stack-owned GitHub OIDC provider is absent or drifted" >&2
    return 1
  fi
}

stack_output() {
  local output_key="$1"

  "${aws_region_command[@]}" cloudformation describe-stacks \
    --stack-name "${stack_name}" \
    --query "Stacks[0].Outputs[?OutputKey=='${output_key}'].OutputValue | [0]" \
    --output text
}

stack_resource_physical_id() {
  local logical_resource_id="$1"

  "${aws_region_command[@]}" cloudformation describe-stack-resource \
    --stack-name "${stack_name}" \
    --logical-resource-id "${logical_resource_id}" \
    --query 'StackResourceDetail.PhysicalResourceId' \
    --output text
}

canonical_iam_document() {
  jq -cS '
    walk(
      if type == "array" and all(.[]; type == "string") then sort
      else .
      end
    )
    | if has("Statement") then
        .Statement |= sort_by(.Sid // (.Action | tostring))
      else
        .
      end
  '
}

assert_exact_iam_document() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  local canonical_expected
  local canonical_actual

  canonical_expected="$(canonical_iam_document <<<"${expected}")"
  canonical_actual="$(canonical_iam_document <<<"${actual}")"
  if [[ "${canonical_actual}" != "${canonical_expected}" ]]; then
    printf '%s\n' "${label} does not match the reviewed fixture contract" >&2
    return 1
  fi
}

assert_exact_role_policy_inventory() {
  local role_name="$1"
  local expected_inline_policy="$2"
  local attached_policies
  local inline_policies

  attached_policies="$(
    aws iam list-attached-role-policies \
      --role-name "${role_name}" \
      --query 'AttachedPolicies[].PolicyArn' \
      --output json
  )"
  if [[ "$(jq -cS 'sort' <<<"${attached_policies}")" != "[]" ]]; then
    printf '%s\n' "IAM role ${role_name} has an unexpected managed policy attachment" >&2
    return 1
  fi

  inline_policies="$(
    aws iam list-role-policies \
      --role-name "${role_name}" \
      --query PolicyNames \
      --output json
  )"
  if [[ "$(jq -cS 'sort' <<<"${inline_policies}")" != "[\"${expected_inline_policy}\"]" ]]; then
    printf '%s\n' "IAM role ${role_name} has an unexpected inline policy inventory" >&2
    return 1
  fi
}

live_role_trust_document() {
  local oidc_provider_arn="$1"

  jq -cn \
    --arg oidc_provider_arn "${oidc_provider_arn}" \
    '{
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: { Federated: $oidc_provider_arn },
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub":
              "repo:knpkv/npm:environment:control-center-live-integration"
          }
        }
      }]
    }'
}

live_role_policy_document() {
  local repository_arn="$1"
  local pipeline_arn="$2"

  jq -cn \
    --arg repository_arn "${repository_arn}" \
    --arg pipeline_arn "${pipeline_arn}" \
    '{
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "Identity",
          Effect: "Allow",
          Action: "sts:GetCallerIdentity",
          Resource: "*"
        },
        {
          Sid: "ListProviderResources",
          Effect: "Allow",
          Action: ["codecommit:ListRepositories", "codepipeline:ListPipelines"],
          Resource: "*"
        },
        {
          Sid: "ReadFixtureRepository",
          Effect: "Allow",
          Action: [
            "codecommit:GetBlob",
            "codecommit:GetDifferences",
            "codecommit:GetPullRequest",
            "codecommit:GetRepository",
            "codecommit:ListPullRequests"
          ],
          Resource: $repository_arn
        },
        {
          Sid: "ReadFixturePipeline",
          Effect: "Allow",
          Action: [
            "codepipeline:GetPipeline",
            "codepipeline:GetPipelineExecution",
            "codepipeline:GetPipelineState",
            "codepipeline:ListActionExecutions",
            "codepipeline:ListPipelineExecutions"
          ],
          Resource: $pipeline_arn
        }
      ]
    }'
}

pipeline_role_trust_document() {
  jq -cn '{
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Service: "codepipeline.amazonaws.com" },
      Action: "sts:AssumeRole"
    }]
  }'
}

pipeline_role_policy_document() {
  local repository_arn="$1"
  local bucket_arn="$2"

  jq -cn \
    --arg repository_arn "${repository_arn}" \
    --arg bucket_arn "${bucket_arn}" \
    '{
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "ReadFixtureSource",
          Effect: "Allow",
          Action: [
            "codecommit:CancelUploadArchive",
            "codecommit:GetBranch",
            "codecommit:GetCommit",
            "codecommit:GetRepository",
            "codecommit:GetUploadArchiveStatus",
            "codecommit:UploadArchive"
          ],
          Resource: $repository_arn
        },
        {
          Sid: "ReadArtifactBucketMetadata",
          Effect: "Allow",
          Action: ["s3:GetBucketAcl", "s3:GetBucketLocation", "s3:GetBucketVersioning"],
          Resource: $bucket_arn
        },
        {
          Sid: "UseArtifactObjects",
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"],
          Resource: ($bucket_arn + "/*")
        }
      ]
    }'
}

bucket_policy_document() {
  local bucket_arn="$1"

  jq -cn \
    --arg bucket_arn "${bucket_arn}" \
    '{
      Version: "2012-10-17",
      Statement: [{
        Sid: "DenyInsecureTransport",
        Effect: "Deny",
        Principal: "*",
        Action: "s3:*",
        Resource: [$bucket_arn, ($bucket_arn + "/*")],
        Condition: { Bool: { "aws:SecureTransport": "false" } }
      }]
    }'
}

verify_deployed_bucket() {
  local role_arn="$1"
  local partition
  local bucket_name
  local bucket_arn
  local public_access
  local encryption
  local lifecycle
  local ownership
  local versioning
  local policy

  if [[ ! "${role_arn}" =~ ^arn:(aws|aws-us-gov):iam::[0-9]{12}:role/.+$ ]]; then
    printf '%s\n' "Stack returned an invalid live integration role ARN" >&2
    return 1
  fi
  partition="${BASH_REMATCH[1]}"
  bucket_name="$(stack_resource_physical_id ArtifactBucket)"
  bucket_arn="arn:${partition}:s3:::${bucket_name}"
  if ! public_access="$(
    "${aws_region_command[@]}" s3api get-public-access-block \
      --bucket "${bucket_name}" \
      --query PublicAccessBlockConfiguration \
      --output json
  )" ||
    ! encryption="$(
      "${aws_region_command[@]}" s3api get-bucket-encryption \
        --bucket "${bucket_name}" \
        --query ServerSideEncryptionConfiguration \
        --output json
    )" ||
    ! lifecycle="$(
      "${aws_region_command[@]}" s3api get-bucket-lifecycle-configuration \
        --bucket "${bucket_name}" \
        --output json
    )" ||
    ! ownership="$(
      "${aws_region_command[@]}" s3api get-bucket-ownership-controls \
        --bucket "${bucket_name}" \
        --query OwnershipControls \
        --output json
    )" ||
    ! versioning="$(
      "${aws_region_command[@]}" s3api get-bucket-versioning \
        --bucket "${bucket_name}" \
        --output json
    )" ||
    ! policy="$(
      "${aws_region_command[@]}" s3api get-bucket-policy \
        --bucket "${bucket_name}" \
        --query Policy \
        --output text
    )"; then
    printf '%s\n' "Unable to inspect deployed fixture artifact bucket" >&2
    return 1
  fi

  if ! jq -e '
    . == {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true
    }
  ' <<<"${public_access}" >/dev/null ||
    ! jq -e '
      .Rules | length == 1 and
      .[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm == "AES256" and
      (.[0].ApplyServerSideEncryptionByDefault | has("KMSMasterKeyID") | not)
    ' <<<"${encryption}" >/dev/null ||
    ! jq -e '
      .Rules | length == 1 and
      .[0].ID == "ExpireFixtureArtifacts" and
      .[0].Status == "Enabled" and
      .[0].Expiration.Days == 1 and
      .[0].NoncurrentVersionExpiration.NoncurrentDays == 6 and
      (
        (
          (.[0] | has("Filter") | not) and
          (.[0] | has("Prefix") | not)
        ) or
        .[0].Filter == { Prefix: "" } or
        .[0].Prefix == ""
      )
    ' <<<"${lifecycle}" >/dev/null ||
    ! jq -e '
      .Rules == [{ ObjectOwnership: "BucketOwnerEnforced" }]
    ' <<<"${ownership}" >/dev/null ||
    ! jq -e '
      .Status == "Enabled"
    ' <<<"${versioning}" >/dev/null; then
    printf '%s\n' "Deployed fixture artifact bucket controls do not match the sealed contract" >&2
    return 1
  fi
  assert_exact_iam_document \
    "Fixture artifact bucket policy" \
    "$(bucket_policy_document "${bucket_arn}")" \
    "${policy}"
}

verify_deployed_iam() {
  local role_arn="$1"
  local repository_name="$2"
  local pipeline_name="$3"
  local existing_oidc_provider_arn="$4"
  local partition
  local account_id
  local live_role_name
  local pipeline_role_name
  local artifact_bucket_name
  local oidc_provider_arn
  local repository_arn
  local pipeline_arn
  local bucket_arn
  local actual_document

  if [[ ! "${role_arn}" =~ ^arn:(aws|aws-us-gov):iam::([0-9]{12}):role/.+$ ]]; then
    printf '%s\n' "Stack returned an invalid live integration role ARN" >&2
    return 1
  fi
  partition="${BASH_REMATCH[1]}"
  account_id="${BASH_REMATCH[2]}"
  live_role_name="$(stack_resource_physical_id LiveIntegrationRole)"
  pipeline_role_name="$(stack_resource_physical_id PipelineRole)"
  artifact_bucket_name="$(stack_resource_physical_id ArtifactBucket)"
  if [[ -n "${existing_oidc_provider_arn}" ]]; then
    oidc_provider_arn="${existing_oidc_provider_arn}"
  else
    oidc_provider_arn="$(stack_resource_physical_id GitHubOidcProvider)"
  fi
  repository_arn="arn:${partition}:codecommit:${aws_region}:${account_id}:${repository_name}"
  pipeline_arn="arn:${partition}:codepipeline:${aws_region}:${account_id}:${pipeline_name}"
  bucket_arn="arn:${partition}:s3:::${artifact_bucket_name}"

  assert_exact_role_policy_inventory "${live_role_name}" "ControlCenterLiveReadOnly" ||
    return 1
  actual_document="$(
    aws iam get-role \
      --role-name "${live_role_name}" \
      --query Role.AssumeRolePolicyDocument \
      --output json
  )"
  assert_exact_iam_document \
    "Live integration role trust policy" \
    "$(live_role_trust_document "${oidc_provider_arn}")" \
    "${actual_document}" ||
    return 1
  actual_document="$(
    aws iam get-role-policy \
      --role-name "${live_role_name}" \
      --policy-name ControlCenterLiveReadOnly \
      --query PolicyDocument \
      --output json
  )"
  assert_exact_iam_document \
    "Live integration role inline policy" \
    "$(live_role_policy_document "${repository_arn}" "${pipeline_arn}")" \
    "${actual_document}" ||
    return 1

  assert_exact_role_policy_inventory "${pipeline_role_name}" "FixturePipelineAccess" ||
    return 1
  actual_document="$(
    aws iam get-role \
      --role-name "${pipeline_role_name}" \
      --query Role.AssumeRolePolicyDocument \
      --output json
  )"
  assert_exact_iam_document \
    "Pipeline role trust policy" \
    "$(pipeline_role_trust_document)" \
    "${actual_document}" ||
    return 1
  actual_document="$(
    aws iam get-role-policy \
      --role-name "${pipeline_role_name}" \
      --policy-name FixturePipelineAccess \
      --query PolicyDocument \
      --output json
  )"
  assert_exact_iam_document \
    "Pipeline role inline policy" \
    "$(pipeline_role_policy_document "${repository_arn}" "${bucket_arn}")" \
    "${actual_document}" ||
    return 1
}

read_fixture_content() {
  local repository_name="$1"
  local commit_specifier="$2"

  "${aws_region_command[@]}" codecommit get-file \
    --repository-name "${repository_name}" \
    --commit-specifier "${commit_specifier}" \
    --file-path fixture.txt \
    --query fileContent \
    --output text |
    base64 --decode
}

put_fixture_change() {
  local repository_name="$1"
  local parent_commit="$2"
  local change_file="$3"

  "${aws_region_command[@]}" codecommit put-file \
    --repository-name "${repository_name}" \
    --branch-name fixture-change \
    --file-path fixture.txt \
    --file-content "fileb://${change_file}" \
    --parent-commit-id "${parent_commit}" \
    --commit-message "Add stable live integration diff" \
    --name "Control Center fixture" \
    --email "control-center-fixture@users.noreply.github.com" \
    --query commitId \
    --output text
}

ensure_fixture_change() {
  local repository_name="$1"
  local main_commit="$2"
  local change_file="$3"
  local fixture_commit
  local fixture_content
  local difference_count
  local difference_path

  if ! fixture_commit="$(
    "${aws_region_command[@]}" codecommit get-branch \
      --repository-name "${repository_name}" \
      --branch-name fixture-change \
      --query 'branch.commitId' \
      --output text 2>/dev/null
  )"; then
    "${aws_region_command[@]}" codecommit create-branch \
      --repository-name "${repository_name}" \
      --branch-name fixture-change \
      --commit-id "${main_commit}"
    fixture_commit="${main_commit}"
  fi

  if [[ "${fixture_commit}" == "${main_commit}" ]]; then
    put_fixture_change "${repository_name}" "${main_commit}" "${change_file}"
    return
  fi

  fixture_content="$(read_fixture_content "${repository_name}" "${fixture_commit}")"
  difference_count="$(
    "${aws_region_command[@]}" codecommit get-differences \
      --repository-name "${repository_name}" \
      --before-commit-specifier "${main_commit}" \
      --after-commit-specifier "${fixture_commit}" \
      --query 'length(differences)' \
      --output text
  )"
  difference_path="$(
    "${aws_region_command[@]}" codecommit get-differences \
      --repository-name "${repository_name}" \
      --before-commit-specifier "${main_commit}" \
      --after-commit-specifier "${fixture_commit}" \
      --query 'differences[0].afterBlob.path' \
      --output text
  )"
  if [[ "${fixture_content}" != "${expected_change_content}" ||
    "${difference_count}" -ne 1 ||
    "${difference_path}" != "fixture.txt" ]]; then
    printf '%s\n' "fixture-change contains unexpected operator-authored drift" >&2
    return 1
  fi

  printf '%s' "${fixture_commit}"
}

find_stable_pull_request() {
  local repository_name="$1"
  local candidate_ids
  local candidate_id
  local target
  local source_reference
  local target_reference

  if ! candidate_ids="$(
    "${aws_region_command[@]}" codecommit list-pull-requests \
      --repository-name "${repository_name}" \
      --pull-request-status OPEN \
      --query pullRequestIds \
      --output text
  )"; then
    printf '%s\n' "Unable to list fixture pull requests" >&2
    return 1
  fi

  while IFS= read -r candidate_id; do
    [[ -n "${candidate_id}" ]] || continue
    if ! target="$(
      "${aws_region_command[@]}" codecommit get-pull-request \
        --pull-request-id "${candidate_id}" \
        --query 'pullRequest.pullRequestTargets[0].[sourceReference,destinationReference]' \
        --output text
    )"; then
      printf '%s\n' "Unable to inspect fixture pull request" >&2
      return 1
    fi
    read -r source_reference target_reference <<<"${target}"
    if [[ "${source_reference}" == "refs/heads/fixture-change" &&
      "${target_reference}" == "refs/heads/main" ]]; then
      printf '%s' "${candidate_id}"
      return
    fi
  done <<<"$(tr '\t' '\n' <<<"${candidate_ids}")"
}

verify_deployed_pipeline() {
  local repository_name="$1"
  local pipeline_name="$2"
  local expected_role_arn="$3"
  local expected_artifact_bucket="$4"
  local pipeline_definition

  if ! pipeline_definition="$(
    "${aws_region_command[@]}" codepipeline get-pipeline \
      --name "${pipeline_name}" \
      --output json
  )"; then
    printf '%s\n' "Unable to inspect deployed fixture pipeline" >&2
    return 1
  fi

  if ! jq -e \
    --arg repository_name "${repository_name}" \
    --arg expected_role_arn "${expected_role_arn}" \
    --arg expected_artifact_bucket "${expected_artifact_bucket}" '
    (.pipeline.version | type == "number" and . > 0 and floor == .) and
    .pipeline.roleArn == $expected_role_arn and
    .pipeline.artifactStore == {
      type: "S3",
      location: $expected_artifact_bucket
    } and
    (.pipeline.stages | map(.name)) == ["Source", "Approval"] and
    (.pipeline.stages[0].actions | map(.name)) == ["ReadFixture"] and
    (.pipeline.stages[1].actions | map(.name)) == ["ConfirmFixture"] and
    (
      .pipeline.stages[0].actions[0] |
      .actionTypeId == {
        category: "Source",
        owner: "AWS",
        provider: "CodeCommit",
        version: "1"
      } and
      .configuration.RepositoryName == $repository_name and
      .configuration.BranchName == "main" and
      .configuration.PollForSourceChanges == "false" and
      .runOrder == 1
    ) and
    (
      .pipeline.stages[1].actions[0] |
      .actionTypeId == {
        category: "Approval",
        owner: "AWS",
        provider: "Manual",
        version: "1"
      } and
      .runOrder == 1
    )
  ' <<<"${pipeline_definition}" >/dev/null; then
    printf '%s\n' "Deployed fixture pipeline definition does not match the sealed contract" >&2
    return 1
  fi

  jq -r '.pipeline.version' <<<"${pipeline_definition}"
}

ensure_recent_successful_pipeline_execution() {
  local pipeline_name="$1"
  local pipeline_version="$2"
  local succeeded_execution
  local execution_id
  local approval_token
  local execution_status

  if ! succeeded_execution="$(
    "${aws_region_command[@]}" codepipeline list-pipeline-executions \
      --pipeline-name "${pipeline_name}" \
      --no-paginate \
      --max-results 5 \
      --query "pipelineExecutionSummaries[?status=='Succeeded' && pipelineVersion==\`${pipeline_version}\`].pipelineExecutionId | [0]" \
      --output text
  )"; then
    printf '%s\n' "Unable to inspect recent fixture pipeline history" >&2
    return 1
  fi
  if [[ -z "${succeeded_execution}" || "${succeeded_execution}" == "None" ]]; then
    if ! execution_id="$(
      "${aws_region_command[@]}" codepipeline start-pipeline-execution \
        --name "${pipeline_name}" \
        --query pipelineExecutionId \
        --output text
    )" || [[ -z "${execution_id}" || "${execution_id}" == "None" ]]; then
      printf '%s\n' "Unable to start a fixture pipeline execution" >&2
      return 1
    fi

    approval_token="None"
    for _ in {1..60}; do
      approval_token="$(
        "${aws_region_command[@]}" codepipeline get-pipeline-state \
          --name "${pipeline_name}" \
          --query "stageStates[?stageName=='Approval' && latestExecution.pipelineExecutionId=='${execution_id}'] | [0].actionStates[?actionName=='ConfirmFixture'] | [0].latestExecution.token" \
          --output text
      )"
      [[ "${approval_token}" != "None" ]] && break
      sleep 5
    done
    if [[ "${approval_token}" == "None" ]]; then
      printf '%s\n' "Fixture pipeline did not reach manual approval" >&2
      return 1
    fi

    if ! "${aws_region_command[@]}" codepipeline put-approval-result \
      --pipeline-name "${pipeline_name}" \
      --stage-name Approval \
      --action-name ConfirmFixture \
      --token "${approval_token}" \
      --result status=Approved,summary="Stable fixture bootstrap" >/dev/null; then
      printf '%s\n' "Unable to approve the fixture pipeline execution" >&2
      return 1
    fi

    execution_status="InProgress"
    for _ in {1..60}; do
      execution_status="$(
        "${aws_region_command[@]}" codepipeline get-pipeline-execution \
          --pipeline-name "${pipeline_name}" \
          --pipeline-execution-id "${execution_id}" \
          --query 'pipelineExecution.status' \
          --output text
      )"
      [[ "${execution_status}" == "Succeeded" ]] && break
      if [[ "${execution_status}" =~ ^(Failed|Stopped|Superseded)$ ]]; then
        printf '%s\n' "Fixture pipeline ended with ${execution_status}" >&2
        return 1
      fi
      sleep 5
    done
    if [[ "${execution_status}" != "Succeeded" ]]; then
      printf '%s\n' "Fixture pipeline did not succeed before the bootstrap deadline" >&2
      return 1
    fi
    succeeded_execution="${execution_id}"
  fi

  printf '%s' "${succeeded_execution}"
}

wait_for_pipeline_action_history() {
  local pipeline_name="$1"
  local succeeded_execution="$2"
  local action_counts
  local source_action_count=0
  local approval_action_count=0

  for _ in {1..12}; do
    if ! action_counts="$(
      "${aws_region_command[@]}" codepipeline list-action-executions \
        --pipeline-name "${pipeline_name}" \
        --filter "pipelineExecutionId=${succeeded_execution}" \
        --query "[length(actionExecutionDetails[?actionName=='ReadFixture' && status=='Succeeded']), length(actionExecutionDetails[?actionName=='ConfirmFixture' && status=='Succeeded'])]" \
        --output text
    )"; then
      printf '%s\n' "Unable to inspect fixture pipeline action history" >&2
      return 1
    fi
    read -r source_action_count approval_action_count <<<"${action_counts}"
    if [[ "${source_action_count}" -eq 1 && "${approval_action_count}" -eq 1 ]]; then
      return
    fi
    sleep 5
  done

  printf '%s\n' "Fixture pipeline lacks successful source and approval action history" >&2
  return 1
}

main() {
  local existing_oidc_provider_arn
  local role_arn
  local repository_name
  local pipeline_name
  local main_file
  local change_file
  local main_commit
  local main_content
  local fixture_commit
  local pull_request_id
  local difference_count
  local artifact_bucket_name
  local pipeline_role_arn
  local pipeline_version
  local succeeded_execution

  temporary_root="$(mktemp -d)"
  trap cleanup EXIT

  existing_oidc_provider_arn="$(resolve_existing_oidc_provider_parameter)"

  "${aws_region_command[@]}" cloudformation deploy \
    --stack-name "${stack_name}" \
    --template-file "${script_root}/template.json" \
    --capabilities CAPABILITY_IAM \
    --no-fail-on-empty-changeset \
    --parameter-overrides \
    "ExistingGitHubOidcProviderArn=${existing_oidc_provider_arn}"

  role_arn="$(stack_output AwsRoleArn)"
  repository_name="$(stack_output CodeCommitRepository)"
  pipeline_name="$(stack_output CodePipelinePipeline)"
  verify_deployed_iam \
    "${role_arn}" \
    "${repository_name}" \
    "${pipeline_name}" \
    "${existing_oidc_provider_arn}"
  verify_deployed_bucket "${role_arn}"
  artifact_bucket_name="$(stack_resource_physical_id ArtifactBucket)"
  pipeline_role_arn="${role_arn%%:role/*}:role/$(stack_resource_physical_id PipelineRole)"
  if ! pipeline_version="$(
    verify_deployed_pipeline \
      "${repository_name}" \
      "${pipeline_name}" \
      "${pipeline_role_arn}" \
      "${artifact_bucket_name}"
  )"; then
    return 1
  fi
  main_file="${temporary_root}/main.txt"
  change_file="${temporary_root}/change.txt"

  printf '%s\n' "${expected_main_content}" >"${main_file}"
  printf '%s\n' "${expected_change_content}" >"${change_file}"

  if ! main_commit="$(
    "${aws_region_command[@]}" codecommit get-branch \
      --repository-name "${repository_name}" \
      --branch-name main \
      --query 'branch.commitId' \
      --output text 2>/dev/null
  )"; then
    main_commit="$(
      "${aws_region_command[@]}" codecommit put-file \
        --repository-name "${repository_name}" \
        --branch-name main \
        --file-path fixture.txt \
        --file-content "fileb://${main_file}" \
        --commit-message "Seed stable live integration fixture" \
        --name "Control Center fixture" \
        --email "control-center-fixture@users.noreply.github.com" \
        --query commitId \
        --output text
    )"
  else
    main_content="$(read_fixture_content "${repository_name}" "${main_commit}")"
    if [[ "${main_content}" != "${expected_main_content}" ]]; then
      printf '%s\n' "main contains unexpected operator-authored drift" >&2
      return 1
    fi
  fi

  fixture_commit="$(ensure_fixture_change "${repository_name}" "${main_commit}" "${change_file}")"

  if ! pull_request_id="$(find_stable_pull_request "${repository_name}")"; then
    return 1
  fi

  if [[ -z "${pull_request_id}" ]]; then
    pull_request_id="$(
      "${aws_region_command[@]}" codecommit create-pull-request \
        --title "Stable Control Center live integration diff" \
        --description "Read-only fixture used by the bounded Control Center live provider journey." \
        --targets \
        "repositoryName=${repository_name},sourceReference=fixture-change,destinationReference=main" \
        --query 'pullRequest.pullRequestId' \
        --output text
    )"
  fi

  difference_count="$(
    "${aws_region_command[@]}" codecommit get-differences \
      --repository-name "${repository_name}" \
      --before-commit-specifier "${main_commit}" \
      --after-commit-specifier "${fixture_commit}" \
      --query 'length(differences)' \
      --output text
  )"
  if [[ "${difference_count}" -ne 1 ]]; then
    printf '%s\n' "Fixture pull request must retain its single deterministic difference" >&2
    return 1
  fi

  if ! succeeded_execution="$(
    ensure_recent_successful_pipeline_execution "${pipeline_name}" "${pipeline_version}"
  )"; then
    return 1
  fi

  if ! wait_for_pipeline_action_history "${pipeline_name}" "${succeeded_execution}"; then
    return 1
  fi

  printf '%s\n' \
    "CONTROL_CENTER_TEST_AWS_ROLE_ARN=${role_arn}" \
    "CONTROL_CENTER_TEST_AWS_REGION=${aws_region}" \
    "CONTROL_CENTER_TEST_CODECOMMIT_REPOSITORY=${repository_name}" \
    "CONTROL_CENTER_TEST_CODEPIPELINE_PIPELINE=${pipeline_name}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
