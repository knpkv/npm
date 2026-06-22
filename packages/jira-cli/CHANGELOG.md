# @knpkv/jira-cli

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
