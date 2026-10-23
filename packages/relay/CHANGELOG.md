# @knpkv/relay

## 0.2.3

### Patch Changes

- [#1086](https://github.com/knpkv/npm/pull/1086) [`9182b48`](https://github.com/knpkv/npm/commit/9182b480640c95dae7d97faa4b1b8b62583dc938) Thanks [@konopkov](https://github.com/konopkov)! - hostd starts on Windows. Paths come from one `HubPaths` table shared by herdr-fleet and herdr-hub: the home directory is `os.homedir()` instead of `HOME`, the host name is `os.hostname()` instead of `HOSTNAME` (so a standalone host started without `HOSTNAME` now reports its real name instead of `localhost`), and Windows keeps fleet configuration under `%APPDATA%` and state under `%LOCALAPPDATA%`. Linux and macOS paths are unchanged. `HERDR_HUB_HOME` and `HERDR_HUB_CONFIG` override them on any OS. The job store's path-identity check now accepts a Windows real path that differs only in drive-letter case or separators. On Windows, hostd runs npm `.cmd` shims as Node with their script, never through a shell. `makeHostdProgram` takes an optional `paths` table.

  The Relay store notes that on Windows owner-only comes from the user profile's ACL.

## 0.2.2

### Patch Changes

- [`4ebe301`](https://github.com/knpkv/npm/commit/4ebe30154220bff53ec507a0d70c5f8f4a543c5a) Thanks [@konopkov](https://github.com/konopkov)! - Docs and comments state each rule and its reason directly instead of pointing at internal decision records.

## 0.2.1

### Patch Changes

- [#743](https://github.com/knpkv/npm/pull/743) [`646b0f0`](https://github.com/knpkv/npm/commit/646b0f0aa3082cbdfe916e9c9ba22de2882cbc3a) Thanks [@konopkov](https://github.com/konopkov)! - A failed run's `cause` is always one of Relay's own sentences, chosen by Pi's reason code (`model_error`, `no_model`, `reset`, anything else); the backend's message is never forwarded, because rly reads the cause aloud.

## 0.2.0

### Minor Changes

- [#723](https://github.com/knpkv/npm/pull/723) [`94d8fdd`](https://github.com/knpkv/npm/commit/94d8fdd38022e2aa68f8bf4dd87924a542e9a7ea) Thanks [@konopkov](https://github.com/konopkov)! - Adds `@knpkv/relay/wire`, a browser-safe entry with Relay's event and session schemas and the HTTP contract every product's `/…/relay` routes speak (`RelayStreamFrame`, the write bodies, and `RelayUnavailableError`, `RelayConflictError` and `RelayBadRequestError`). It imports only `effect` and `@knpkv/capability`; the build and `test:pack` fail if it reaches anything else.

  The event stream now reports a person's messages: a Snapshot lists the ones still `queued`, and `MessageQueued`, `MessagePlaced` and `MessageWithdrawn` follow each one, so a client never guesses from its own send. `Snapshot.queued` is a new required field.

### Patch Changes

- [#739](https://github.com/knpkv/npm/pull/739) [`0728c72`](https://github.com/knpkv/npm/commit/0728c72870f6c648626da0493cc00d8c65c47d60) Thanks [@konopkov](https://github.com/konopkov)! - On Bun, a second owner of a Relay store is refused as `RelayStoreLocked` again, not as a failed commit: the store lock runs its pragma, `BEGIN IMMEDIATE` and `COMMIT` one call at a time, because Bun's multi-statement `exec` reported the refused `BEGIN` as `cannot commit - no transaction is active`. When neither `node:sqlite` nor `bun:sqlite` can load, the lock's error message now names both failures, so a Node without `node:sqlite` reports its own failure, not only "Cannot find module bun:sqlite".

- [#736](https://github.com/knpkv/npm/pull/736) [`f925ee2`](https://github.com/knpkv/npm/commit/f925ee27ba3689acb941187cce4ee808301f5f95) Thanks [@konopkov](https://github.com/konopkov)! - Closing a Relay harness now frees its store at once, so the same process can open it again. Ownership moves from the libsql connection's exclusive mode to an exclusive lock on `<store>.lock`, held through the runtime's own SQLite (`node:sqlite` on Node, `bun:sqlite` on Bun) with `exec` only. libsql keeps a closed connection, and the lock it took, until its prepared statements are garbage-collected, so a store that had been opened once could not be reopened in that process. The driver loads when a store opens, never at import, so Relay still loads on Bun versions without `node:sqlite`.

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
