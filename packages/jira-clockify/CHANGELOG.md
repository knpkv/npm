# @knpkv/jira-clockify

## 1.0.1

### Patch Changes

- [#103](https://github.com/knpkv/npm/pull/103) [`477e4c6`](https://github.com/knpkv/npm/commit/477e4c60fa5c501883be6c03629da5a3cc91444c) Thanks [@konopkov](https://github.com/konopkov)! - Add shared Atlassian auth profile storage for multi-account and multi-site OAuth use.

  Jira and Confluence now expose `auth profiles`, `auth use <profile>`, and `auth remove <profile>` commands backed by shared profile management in `@knpkv/atlassian-common`. Confluence also migrates existing legacy auth/config files on first use. Agent skills and docs now describe the profile commands and active-profile checks.

- [#105](https://github.com/knpkv/npm/pull/105) [`a3a4d3a`](https://github.com/knpkv/npm/commit/a3a4d3a14fafe235bc901ed5015bb9bd82c59281) Thanks [@konopkov](https://github.com/konopkov)! - Add a unified Atlassian profile manager CLI with cross-tool profile listing, selection, diagnostics, token refresh, and scope validation helpers.

  Update bundled Jira, Confluence, and Jira Clockify agent skills to recommend the unified profile diagnostics workflow.

- Updated dependencies [[`477e4c6`](https://github.com/knpkv/npm/commit/477e4c60fa5c501883be6c03629da5a3cc91444c), [`a3a4d3a`](https://github.com/knpkv/npm/commit/a3a4d3a14fafe235bc901ed5015bb9bd82c59281)]:
  - @knpkv/atlassian-common@0.4.0
  - @knpkv/jira-cli@1.1.0
  - @knpkv/agent-skills@0.2.2

## 1.0.0

### Major Changes

- [#99](https://github.com/knpkv/npm/pull/99) [`59478b0`](https://github.com/knpkv/npm/commit/59478b0d059d359feaf38222e5e55f748ee389d7) Thanks [@konopkov](https://github.com/konopkov)! - Refactor CLI command surfaces around resource-first groups and remove the legacy top-level aliases.

  - Jira issue reads now live under `jira issue get` and `jira issue search`; version reads and writes use `jira version get`, `jira version update`, and `jira version related-work`.
  - Confluence workspace setup now uses `confluence workspace clone`, page operations use `confluence page`, and sync/git-backed operations use `confluence sync`.
  - JCF timer operations now use `jcf timer`, ticket listing uses `jcf issue list`, and reconciliation uses `jcf sync reconcile`.
  - Agent skills and product-local skill copies now document the same canonical commands.

### Minor Changes

- [#94](https://github.com/knpkv/npm/pull/94) [`a12490d`](https://github.com/knpkv/npm/commit/a12490d423b1d4f4e1e75fee0e34093380b5389a) Thanks [@konopkov](https://github.com/konopkov)! - Add `jcf reconcile` to compare Clockify time against Jira worklogs over a period and fill the gaps. Work is bucketed per ticket per local day and summed on each side, so entries split across either system don't read as discrepancies. Pick a direction — `clockify-to-jira` (default) or `jira-to-clockify` — to choose which side is the source of truth; the command reports every bucket with its delta, then prompts to apply each missing slice into the under-logged side (it only ever adds, never deletes, and posts the delta so re-runs converge). Period flags: `--day` (default), `--week` (last 7 days), or a custom `--since`/`--until` window.

- [#92](https://github.com/knpkv/npm/pull/92) [`ceb4006`](https://github.com/knpkv/npm/commit/ceb4006fbae04f99219bacc23022c3143ecb4fd5) Thanks [@konopkov](https://github.com/konopkov)! - Surface _why_ a Jira worklog failed and stop offering pointless retries. The worklog post now reports a typed outcome (`Posted` / `NotLoggedIn` / `Failed{message}`) instead of a bare boolean, so:

  - the `jcf stop` CLI and the TUI retry popup show the actual failure reason (HTTP status / Jira error message) instead of a bare `✗`;
  - a not-logged-in failure is recognised as unrecoverable — the CLI/TUI show the `jcf auth jira login` hint and suppress the retry affordance rather than looping on a request that can never succeed;
  - a transient failure still offers retry, now labelled with the reason.

  Also guards the TUI Retry action against a double-keypress that could double-log the worklog.

### Patch Changes

- [#95](https://github.com/knpkv/npm/pull/95) [`53f260b`](https://github.com/knpkv/npm/commit/53f260bb01dc810af7926ab862f75590e766a531) Thanks [@konopkov](https://github.com/konopkov)! - `jcf reconcile` (clockify→jira) now uses the Clockify entry's own description as the Jira worklog comment instead of a fixed "Reconciled from Clockify". For a bucket spanning several entries the descriptions are ticket-prefix-stripped, deduped, and joined; it only falls back to the generic note when there's nothing meaningful to carry over.

- [#96](https://github.com/knpkv/npm/pull/96) [`8f1ff75`](https://github.com/knpkv/npm/commit/8f1ff75cdb5ef74bd4967f1c99c2e7877a844eed) Thanks [@konopkov](https://github.com/konopkov)! - Fix Jira worklog posts failing with a transport error in the TUI. The TUI runs under Bun, where the undici-based HTTP client (used by the raw Jira worklog POST) fails; the CLI runs under Node and was unaffected. Switch the shared HTTP client to the fetch implementation, which works in both Bun and Node — the same fetch the Jira/Clockify API clients already use.

- Updated dependencies [[`0eec900`](https://github.com/knpkv/npm/commit/0eec9001c32e70493be985449798d731f7dfb9ba), [`fdfd789`](https://github.com/knpkv/npm/commit/fdfd7897442a4616087463c60ae54d94f1726dd3), [`59478b0`](https://github.com/knpkv/npm/commit/59478b0d059d359feaf38222e5e55f748ee389d7)]:
  - @knpkv/jira-cli@1.0.0
  - @knpkv/agent-skills@0.2.1

## 0.5.0

### Minor Changes

- [#89](https://github.com/knpkv/npm/pull/89) [`7ee4f6d`](https://github.com/knpkv/npm/commit/7ee4f6d790ad24f2e52482fd29f223f702167e45) Thanks [@konopkov](https://github.com/konopkov)! - Let users retry a failed Jira worklog after a partial timer stop (Clockify saved, Jira failed) — via a "Retry" action in the TUI result popup and a retry prompt in the `jcf stop` CLI flow. Also fix `jcf start/stop/log <KEY>` reporting "Ticket not found in Jira" when actually not logged in: these now detect the missing Jira login and point to `jcf auth jira login`.

## 0.4.0

### Minor Changes

- [#81](https://github.com/knpkv/npm/pull/81) [`19c1538`](https://github.com/knpkv/npm/commit/19c153835bc198b9e407a013c16775c3fb7eb357) Thanks [@konopkov](https://github.com/konopkov)! - Ship agent skills alongside each CLI package and add an installer package plus per-CLI `skills install` commands for Codex and Claude.

- [#71](https://github.com/knpkv/npm/pull/71) [`e3c3805`](https://github.com/knpkv/npm/commit/e3c3805ee527a6edb69ed91977c95c586b563ff9) Thanks [@konopkov](https://github.com/konopkov)! - Migrate the package workspace to Effect v4 beta.

  This updates runtime and peer dependencies to the Effect v4 beta module layout,
  adopts Effect platform/runtime services for Node process, HTTP, filesystem, and
  clock access, and refreshes package export metadata to point published type
  entries at emitted `dist/*.d.ts` declarations.

  CodeCommit packages now use Effect v4-compatible AWS and cache layers, including
  typed `distilled-aws` context services, shared cached-comment decoding, and
  schema-derived config defaults. Jira and Confluence OAuth callback servers bind
  the expected local callback port range again under the Effect v4 Node HTTP
  server layer.

  The retired Claude AI packages have been removed from the workspace.

### Patch Changes

- [#88](https://github.com/knpkv/npm/pull/88) [`a245d53`](https://github.com/knpkv/npm/commit/a245d534f3946c0b3d8b0a0380dbd702d9f2982d) Thanks [@konopkov](https://github.com/konopkov)! - Fix the TUIs hanging after quit. On a clean in-app quit the main fiber exits with code 0, and because OpenTUI keeps stdin in raw mode (so Ctrl-C arrives as a keypress, not a SIGINT) `runMain`'s default teardown never called `process.exit`. The atom runtime kept the event loop alive (SQLite repos, HTTP client, EventsHub PubSub), so the process hung after the UI had already torn down. Both bins now pass a teardown that always terminates the host process.

- Updated dependencies [[`c697d3c`](https://github.com/knpkv/npm/commit/c697d3c4ab779f14f017d3ec8fc8d1bffa1493b5), [`19c1538`](https://github.com/knpkv/npm/commit/19c153835bc198b9e407a013c16775c3fb7eb357), [`e3c3805`](https://github.com/knpkv/npm/commit/e3c3805ee527a6edb69ed91977c95c586b563ff9)]:
  - @knpkv/agent-skills@0.2.0
  - @knpkv/jira-cli@0.3.0
  - @knpkv/atlassian-common@0.3.0
  - @knpkv/clockify-api-client@0.3.0
  - @knpkv/jira-api-client@0.3.0

## 0.3.0

### Minor Changes

- [#69](https://github.com/knpkv/npm/pull/69) [`ebe2800`](https://github.com/knpkv/npm/commit/ebe280079863e7236de20bf06c0db6446215dab1) Thanks @konopkov! - Add ways to log time when the timer was never started.
  - `jcf start KEY --ago <duration>` / `--since <HH:MM|ISO>` backdates the timer
    start to correct a forgotten start.
  - `jcf stop` with no running timer now offers to add a **correction interval**:
    pick a ticket, enter a duration and start time, and it writes a completed
    Clockify entry plus the matching Jira worklog.
  - `jcf log` gains `--at HH:MM` to set the start time (was hardcoded to 09:00) and
    now resolves project/billable/tags like `start` does.

  Internally, the Clockify-entry + Jira-worklog write path is shared via a new
  `TimerService.logManual`, and the per-command Jira issue fetch is centralised in
  `fetchTicketByKey`.

### Patch Changes

- Updated dependencies [[`ebe2800`](https://github.com/knpkv/npm/commit/ebe280079863e7236de20bf06c0db6446215dab1)]:
  - @knpkv/jira-cli@0.2.0

## 0.2.0

### Minor Changes

- [#61](https://github.com/knpkv/npm/pull/61) [`fc7be8f`](https://github.com/knpkv/npm/commit/fc7be8ffaf5b6b094c7f81551e8ace6f2a8f2c4c) Thanks @konopkov! - feat: add jira-api-client and atlassian-common packages
  - New @knpkv/atlassian-common: shared AST types, serializers, auth, and config
  - New @knpkv/jira-api-client: Effect-based Jira REST API client (openapi-gen)
  - Updated @knpkv/confluence-api-client: regenerated with openapi-gen
  - Updated @knpkv/confluence-to-markdown: use new generated API client

### Patch Changes

- Updated dependencies [[`fc7be8f`](https://github.com/knpkv/npm/commit/fc7be8ffaf5b6b094c7f81551e8ace6f2a8f2c4c)]:
  - @knpkv/atlassian-common@0.2.0
  - @knpkv/jira-api-client@0.2.0
  - @knpkv/clockify-api-client@0.2.0
  - @knpkv/jira-cli@0.1.1
