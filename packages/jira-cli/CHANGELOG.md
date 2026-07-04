# @knpkv/jira-cli

## 1.1.1

### Patch Changes

- Updated dependencies [[`734f891`](https://github.com/knpkv/npm/commit/734f8911d930cedc8642d5e2bd9fa73c76a99054)]:
  - @knpkv/atlassian-common@1.0.0

## 1.1.0

### Minor Changes

- [#103](https://github.com/knpkv/npm/pull/103) [`477e4c6`](https://github.com/knpkv/npm/commit/477e4c60fa5c501883be6c03629da5a3cc91444c) Thanks [@konopkov](https://github.com/konopkov)! - Add shared Atlassian auth profile storage for multi-account and multi-site OAuth use.

  Jira and Confluence now expose `auth profiles`, `auth use <profile>`, and `auth remove <profile>` commands backed by shared profile management in `@knpkv/atlassian-common`. Confluence also migrates existing legacy auth/config files on first use. Agent skills and docs now describe the profile commands and active-profile checks.

### Patch Changes

- [#105](https://github.com/knpkv/npm/pull/105) [`a3a4d3a`](https://github.com/knpkv/npm/commit/a3a4d3a14fafe235bc901ed5015bb9bd82c59281) Thanks [@konopkov](https://github.com/konopkov)! - Add a unified Atlassian profile manager CLI with cross-tool profile listing, selection, diagnostics, token refresh, and scope validation helpers.

  Update bundled Jira, Confluence, and Jira Clockify agent skills to recommend the unified profile diagnostics workflow.

- Updated dependencies [[`477e4c6`](https://github.com/knpkv/npm/commit/477e4c60fa5c501883be6c03629da5a3cc91444c), [`a3a4d3a`](https://github.com/knpkv/npm/commit/a3a4d3a14fafe235bc901ed5015bb9bd82c59281)]:
  - @knpkv/atlassian-common@0.4.0
  - @knpkv/agent-skills@0.2.2

## 1.0.0

### Major Changes

- [#99](https://github.com/knpkv/npm/pull/99) [`59478b0`](https://github.com/knpkv/npm/commit/59478b0d059d359feaf38222e5e55f748ee389d7) Thanks [@konopkov](https://github.com/konopkov)! - Refactor CLI command surfaces around resource-first groups and remove the legacy top-level aliases.

  - Jira issue reads now live under `jira issue get` and `jira issue search`; version reads and writes use `jira version get`, `jira version update`, and `jira version related-work`.
  - Confluence workspace setup now uses `confluence workspace clone`, page operations use `confluence page`, and sync/git-backed operations use `confluence sync`.
  - JCF timer operations now use `jcf timer`, ticket listing uses `jcf issue list`, and reconciliation uses `jcf sync reconcile`.
  - Agent skills and product-local skill copies now document the same canonical commands.

### Patch Changes

- [#97](https://github.com/knpkv/npm/pull/97) [`0eec900`](https://github.com/knpkv/npm/commit/0eec9001c32e70493be985449798d731f7dfb9ba) Thanks [@konopkov](https://github.com/konopkov)! - Fix `serializeIssue` crashing with `yaml.safeDump is removed in js-yaml 4`. gray-matter's default YAML engine calls js-yaml 3's `safeDump`/`safeLoad`, both removed in js-yaml 4 — which the workspace pins via a security override. The front-matter writer now supplies a custom engine backed by js-yaml 4's `dump`/`load`.

- [#98](https://github.com/knpkv/npm/pull/98) [`fdfd789`](https://github.com/knpkv/npm/commit/fdfd7897442a4616087463c60ae54d94f1726dd3) Thanks [@konopkov](https://github.com/konopkov)! - Add Jira Markdown Sync workspace primitives, field reconciliation helpers, and a live Jira integration test using `JIRA_API_KEY`.

- Updated dependencies [[`59478b0`](https://github.com/knpkv/npm/commit/59478b0d059d359feaf38222e5e55f748ee389d7)]:
  - @knpkv/agent-skills@0.2.1

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
