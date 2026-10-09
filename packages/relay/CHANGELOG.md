# @knpkv/relay

## 0.1.0

### Minor Changes

- [#640](https://github.com/knpkv/npm/pull/640) [`c09fc0f`](https://github.com/knpkv/npm/commit/c09fc0f2e807546f5910a4e9240a7ce848d3e442) Thanks [@konopkov](https://github.com/konopkov)! - Relay bundles what it uses from Pi and depends only on `typebox` from Pi's tree. Installing it no longer pulls in the Anthropic, OpenAI, Google and Bedrock SDKs or esbuild. Pi's MIT notice ships in `LICENSE-THIRD-PARTY.md`.

- [#640](https://github.com/knpkv/npm/pull/640) [`c09fc0f`](https://github.com/knpkv/npm/commit/c09fc0f2e807546f5910a4e9240a7ce848d3e442) Thanks [@konopkov](https://github.com/konopkov)! - `decide` takes the session's `ObjectRef`: a confirmation raised in one session can't be answered from another, and the call stays pending.

- [#640](https://github.com/knpkv/npm/pull/640) [`c09fc0f`](https://github.com/knpkv/npm/commit/c09fc0f2e807546f5910a4e9240a7ce848d3e442) Thanks [@konopkov](https://github.com/konopkov)! - Relay names each run by the `requestId`s it answers (on the Snapshot and on every run-ending event), cancels only the run a `runId` names, tells a late or repeated confirmation answer whether it was decided, expired or unknown, reports each backend as Unverified, Ready or Unavailable with a one-line fix, and lets a session switch backend from its next turn.

- [#640](https://github.com/knpkv/npm/pull/640) [`c09fc0f`](https://github.com/knpkv/npm/commit/c09fc0f2e807546f5910a4e9240a7ce848d3e442) Thanks [@konopkov](https://github.com/konopkov)! - Relay's event stream gives the dock what it renders without guessing:

  - `RunStarted` names the run.
  - Every tool call carries a display-safe summary, and a completed write carries its receipt (CodeCommit: the operation id and the pull request's console link).
  - `ConfirmationResolved` reports confirmed, declined or expired.
  - Snapshot messages have ids.
  - The session says whether its runs can be cancelled.

- [#536](https://github.com/knpkv/npm/pull/536) [`4c21182`](https://github.com/knpkv/npm/commit/4c211825fc99debbdc85f4cb71ea4d566e51e26f) Thanks [@konopkov](https://github.com/konopkov)! - New package: the Relay agent harness. One durable session per product object on Pi Durable over SQLite (`@libsql/client`), model turns through the user's own Claude Code or Codex CLI login with every CLI tool withheld, product capabilities with a `read`/`write`/`host` permission gate enforced in the harness (writes wait for the person to confirm the exact action; an interrupted write is never repeated), an owner-only single-process store, and one typed event stream for the dock.

- [#640](https://github.com/knpkv/npm/pull/640) [`c09fc0f`](https://github.com/knpkv/npm/commit/c09fc0f2e807546f5910a4e9240a7ce848d3e442) Thanks [@konopkov](https://github.com/konopkov)! - A Relay message can carry context the person attached; the model reads it, but the transcript does not show it. CodeCommit web uses it to send the review findings the person is looking at, with the head they were reviewed at.

- [#710](https://github.com/knpkv/npm/pull/710) [`5a93f2f`](https://github.com/knpkv/npm/commit/5a93f2fe9fdbab1978a7ae68832e46d00c2be693) Thanks [@konopkov](https://github.com/konopkov)! - Refuse a store directory, database or SQLite sidecar file that is a symbolic link, even a dangling one, with `RelayStoreLinked`, before Relay re-permissions or writes anything, so conversation content never lands where a link points.
