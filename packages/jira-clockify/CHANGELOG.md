# @knpkv/jira-clockify

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
