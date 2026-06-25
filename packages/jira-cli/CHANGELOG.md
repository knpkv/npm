# @knpkv/jira-cli

## 0.3.0

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

- Updated dependencies [[`c697d3c`](https://github.com/knpkv/npm/commit/c697d3c4ab779f14f017d3ec8fc8d1bffa1493b5), [`19c1538`](https://github.com/knpkv/npm/commit/19c153835bc198b9e407a013c16775c3fb7eb357), [`e3c3805`](https://github.com/knpkv/npm/commit/e3c3805ee527a6edb69ed91977c95c586b563ff9)]:
  - @knpkv/agent-skills@0.2.0
  - @knpkv/atlassian-common@0.3.0
  - @knpkv/jira-api-client@0.3.0

## 0.2.0

### Minor Changes

- [#69](https://github.com/knpkv/npm/pull/69) [`ebe2800`](https://github.com/knpkv/npm/commit/ebe280079863e7236de20bf06c0db6446215dab1) Thanks @konopkov! - Add a `jira version` command for working with Jira project versions (releases),
  backed by a new `VersionService`.
  - `jira version list --project KEY` lists versions with Driver, Contributors and
    Approver fields resolved to display names. `--released`/`--unreleased` filter
    by state, `--custom-field "<name>"` (repeatable) includes per-ticket custom
    field values, and `--json` emits the raw objects.
  - `jira version view <id>` shows a single version.
  - `jira version set <id> --description <text>` edits the description.
  - `jira version relatedwork list|add <id>` manages "Related work" links (the
    Confluence pages surfaced on a release report).

  `version set` requires the new `manage:jira-project` OAuth scope. `relatedwork
add` uses the existing `write:jira-work` scope. Re-run `jira auth login` to
  grant the new scope.

## 0.1.1

### Patch Changes

- Updated dependencies [[`fc7be8f`](https://github.com/knpkv/npm/commit/fc7be8ffaf5b6b094c7f81551e8ace6f2a8f2c4c)]:
  - @knpkv/atlassian-common@0.2.0
  - @knpkv/jira-api-client@0.2.0
