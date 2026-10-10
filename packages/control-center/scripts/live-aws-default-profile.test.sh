#!/usr/bin/env bash
# Exercises live-aws-default-profile.sh without AWS: file shape, mode, silence, and rejected inputs.

set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/live-aws-default-profile.sh"
readonly script
test_root="$(mktemp -d)"
readonly test_root
trap 'rm -rf -- "${test_root}"' EXIT

fail() {
  printf '%s\n' "live-aws-default-profile.test: $1" >&2
  exit 1
}

# Runs the script with exactly the given environment; its command prints the AWS variables it sees.
run() {
  env -i PATH="${PATH}" "$@" bash "${script}" "${target}" env
}

readonly target="${test_root}/aws/credentials"
output="$(run AWS_ACCESS_KEY_ID=ASIAEXAMPLE AWS_SECRET_ACCESS_KEY=secret-value AWS_SESSION_TOKEN=token-value 2>&1)"
[[ "$(grep '^AWS_' <<<"${output}")" == "AWS_SHARED_CREDENTIALS_FILE=${target}" ]] ||
  fail "command did not run with only the credentials file in its AWS environment"
[[ "$(grep -vc '^\(PATH\|AWS_SHARED_CREDENTIALS_FILE\|PWD\|SHLVL\|_\)=' <<<"${output}")" == "0" ]] ||
  fail "script printed output of its own"
expected=$'[default]\naws_access_key_id = ASIAEXAMPLE\naws_secret_access_key = secret-value\naws_session_token = token-value'
[[ "$(cat "${target}")" == "${expected}" ]] || fail "unexpected credentials file content"
[[ "$(stat -c '%a' "${target}")" == "600" ]] || fail "credentials file is not mode 600"
[[ "$(stat -c '%a' "$(dirname "${target}")")" == "700" ]] || fail "credentials directory is not mode 700"

# A rerun replaces the file rather than appending a second section.
run AWS_ACCESS_KEY_ID=ASIASECOND AWS_SECRET_ACCESS_KEY=secret-value AWS_SESSION_TOKEN=token-value >/dev/null
[[ "$(grep -c '^\[default\]$' "${target}")" == "1" ]] || fail "rerun did not replace the file"
grep -q '^aws_access_key_id = ASIASECOND$' "${target}" || fail "rerun did not write the new session"

before="$(cat "${target}")"
for rejected in \
  "AWS_SECRET_ACCESS_KEY=secret-value AWS_SESSION_TOKEN=token-value" \
  "AWS_ACCESS_KEY_ID=ASIAEXAMPLE AWS_SECRET_ACCESS_KEY=secret-value AWS_SESSION_TOKEN=" \
  "AWS_ACCESS_KEY_ID=ASIAEXAMPLE AWS_SECRET_ACCESS_KEY=secret-value AWS_SESSION_TOKEN=[profile]"; do
  read -r -a assignments <<<"${rejected}"
  if run "${assignments[@]}" 2>/dev/null; then
    fail "accepted invalid input: ${rejected%%=*}"
  fi
done
if run AWS_ACCESS_KEY_ID=ASIAEXAMPLE AWS_SECRET_ACCESS_KEY=$'secret\naws_role_arn = injected' \
  AWS_SESSION_TOKEN=token-value 2>/dev/null; then
  fail "accepted a multi-line secret"
fi
[[ "$(cat "${target}")" == "${before}" ]] || fail "a rejected run changed the credentials file"
[[ -z "$(find "$(dirname "${target}")" -name 'credentials.*')" ]] || fail "a staged file was left behind"

if env -i PATH="${PATH}" bash "${script}" "${target}" 2>/dev/null; then
  fail "accepted a missing command"
fi
