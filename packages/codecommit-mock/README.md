# CodeCommit mock

Deterministic loopback data plane for the real CodeCommit clients. It accepts signed AWS JSON 1.1 CodeCommit requests and STS Query identity requests. No AWS account is used.

```bash
pnpm mock:codecommit
```

The command prints these values:

- `CODECOMMIT_MOCK_ENDPOINT`, the loopback AWS protocol origin.
- `CODECOMMIT_MOCK_GIT_REPOSITORY` and `CODECOMMIT_MOCK_GIT_REMOTE`, the repository name and scoped `file://` remote used by Control Center review checkout.
- `CONTROL_CENTER_AGENT_OPENAI_API_URL` and `CONTROL_CENTER_AGENT_OPENAI_MODEL`, the deterministic review model.
- A copyable AWS console PR URL.

The Git remote is a server-private fixture locator. Do not return it through an authenticated API, browser storage, logs, or public diagnostics. The mock deletes its temporary repository when the process exits.

Run the TUI with the AWS endpoint:

```bash
CODECOMMIT_MOCK_ENDPOINT=http://127.0.0.1:<port> \
pnpm --filter @knpkv/codecommit start
```

Mock mode never resolves the selected AWS profile. It signs with a fixed non-secret fixture identity, then removes authorization and session-token headers before loopback dispatch. The TUI still reads its normal account selection; use region `eu-west-1` for the bundled scenario. Control Center uses the same isolated runtime for configured CodeCommit connections; other providers keep their real origins and credentials.

For the full Control Center review cycle, copy the printed values into the server environment and enable the Review Sandbox worker:

```bash
CODECOMMIT_MOCK_ENDPOINT=http://127.0.0.1:<port> \
CODECOMMIT_MOCK_GIT_REPOSITORY=payments-api \
CODECOMMIT_MOCK_GIT_REMOTE=file:///tmp/codecommit-mock-git-.../payments-api.git \
CONTROL_CENTER_AGENT_OPENAI_API_URL=http://127.0.0.1:<port>/v1 \
CONTROL_CENTER_AGENT_OPENAI_MODEL=codecommit-mock-review \
CONTROL_CENTER_PR_REVIEW_SBX_ENABLED=true \
pnpm --filter @knpkv/control-center start
```

This path needs `git`, Docker, and `sbx`. It does not need an AWS account or model credentials. Control Center must explicitly accept the two Git fixture variables before this checkout path becomes active.

## Review cycle

Advance the PR head:

```bash
curl -X POST http://127.0.0.1:<port>/__mock/push \
  -H 'content-type: application/json' \
  -d '{"pullRequestId":"17"}'
```

Add an author response:

```bash
curl -X POST http://127.0.0.1:<port>/__mock/comment \
  -H 'content-type: application/json' \
  -d '{"pullRequestId":"17","content":"Addressed in revision 2."}'
```

Inspect provider calls and durable mock state with `GET /__mock/state`; restore the scenario with `POST /__mock/reset`.

Push first moves the fixture's advertised Git source ref, then advances the provider revision. Reset moves the ref back before clearing provider state. A fresh `file://` clone cannot read revision 2 before push or after reset.

Implemented operations cover identity, repository and PR discovery, exact revisions, differences, blobs, comments, replies, comment updates, approvals, approval evaluation, and mergeability. The loopback server does not implement Git smart HTTP. The CLI instead owns a scoped bare Git remote for local review checkout. The opt-in live AWS suite still owns credential-helper and CodeCommit Git transport acceptance.
