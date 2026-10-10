#!/usr/bin/env bash
# Binds the current AWS session to the `default` shared-config profile.
#
# Control Center resolves a named profile only from shared configuration, never from ambient
# environment credentials. The live AWS workflows receive an OIDC session as
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN, so this script writes that session
# into a private credentials file as `[default]` and then runs the live test command with
# AWS_SHARED_CREDENTIALS_FILE pointing at it and the three session variables removed.
#
# Usage: live-aws-default-profile.sh <credentials-file> <command> [arguments...]
# Writes the file with mode 0600 (its directory 0700), prints nothing itself, and execs <command>.

set -euo pipefail

if [[ $# -lt 2 || -z "$1" ]]; then
  printf '%s\n' "usage: live-aws-default-profile.sh <credentials-file> <command> [arguments...]" >&2
  exit 2
fi
readonly target="$1"
shift

for name in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN; do
  value="${!name:-}"
  # One INI line per value: a newline, carriage return or bracket could start another key or section.
  if [[ -z "${value}" || "${value}" == *[$'\n\r[]']* ]]; then
    printf '%s\n' "live-aws-default-profile: ${name} is missing or not a single-line value" >&2
    exit 1
  fi
done

umask 077
mkdir -p -- "$(dirname -- "${target}")"
staged="$(mktemp -- "${target}.XXXXXX")"
trap 'rm -f -- "${staged}"' EXIT
printf '[default]\naws_access_key_id = %s\naws_secret_access_key = %s\naws_session_token = %s\n' \
  "${AWS_ACCESS_KEY_ID}" "${AWS_SECRET_ACCESS_KEY}" "${AWS_SESSION_TOKEN}" >"${staged}"
chmod 600 -- "${staged}"
mv -f -- "${staged}" "${target}"
trap - EXIT

exec env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
  AWS_SHARED_CREDENTIALS_FILE="${target}" "$@"
