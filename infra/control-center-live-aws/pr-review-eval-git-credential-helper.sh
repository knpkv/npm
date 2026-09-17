#!/usr/bin/env bash

set -euo pipefail

readonly profile="${CONTROL_CENTER_CODECOMMIT_GIT_PROFILE:?CodeCommit Git profile is required}"
readonly region="${CONTROL_CENTER_CODECOMMIT_GIT_REGION:?CodeCommit Git region is required}"

while IFS='=' read -r -d '' environment_name _; do
  case "${environment_name^^}" in
    AWS_ACCESS_KEY_ID | AWS_SECRET_ACCESS_KEY | AWS_SESSION_TOKEN | AWS_SECURITY_TOKEN | \
      AWS_CREDENTIAL_EXPIRATION | AWS_ROLE_ARN | AWS_WEB_IDENTITY_TOKEN_FILE | \
      AWS_ROLE_SESSION_NAME | AWS_REGION | AWS_DEFAULT_REGION)
      unset "${environment_name}"
      ;;
  esac
done < <(env -0)

exec aws --profile "${profile}" --region "${region}" codecommit credential-helper "$@"
