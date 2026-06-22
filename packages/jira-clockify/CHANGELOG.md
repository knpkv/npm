# @knpkv/jira-clockify

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
