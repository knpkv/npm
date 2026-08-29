# CodeCommit mock

Deterministic loopback data plane for the real CodeCommit clients. It accepts signed AWS JSON 1.1 CodeCommit requests and STS Query identity requests. No AWS account is used.

```bash
pnpm mock:codecommit
```

The command prints `CODECOMMIT_MOCK_ENDPOINT` and a copyable AWS console PR URL. Run the TUI or Control Center with that endpoint:

```bash
CODECOMMIT_MOCK_ENDPOINT=http://127.0.0.1:<port> \
pnpm --filter @knpkv/codecommit start
```

Mock mode never resolves the selected AWS profile. It signs with a fixed non-secret fixture identity, then removes authorization and session-token headers before loopback dispatch. The TUI still reads its normal account selection; use region `eu-west-1` for the bundled scenario. Control Center uses the same isolated runtime for configured CodeCommit connections; other providers keep their real origins and credentials.

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

Implemented operations cover identity, repository and PR discovery, exact revisions, differences, blobs, comments, replies, comment updates, approvals, approval evaluation, and mergeability. Git smart HTTP is deliberately outside this mock. Existing source-workspace tests prove exact local checkout; the opt-in live AWS suite owns credential-helper and CodeCommit Git transport acceptance.
