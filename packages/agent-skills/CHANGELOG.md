# @knpkv/agent-skills

## 0.3.1

### Patch Changes

- [#361](https://github.com/knpkv/npm/pull/361) [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade the workspace to Effect 4.0.0-rc.109, pin the vendored Effect reference to that exact upstream release, guard source/package alignment, and bound Control Center test concurrency for reliable CI execution.

## 0.3.0

### Minor Changes

- [#366](https://github.com/knpkv/npm/pull/366) [`b08ca20`](https://github.com/knpkv/npm/commit/b08ca2004b3efcd72a695b44c72b56dae20afdfd) Thanks [@konopkov](https://github.com/konopkov)! - Add `confluence folder` and `confluence search`, so folders and content lookup no longer need the Confluence UI or a separate MCP client.

  `folder get`, `folder children` and `folder create` cover the container the page commands cannot address — `/pages/{id}` 404s on a folder id and vice versa. `folder get` and `folder children` accept either `--folder-id` or `--url`, and a folder URL pasted into either is read for its id, because the URL bar is the only place a folder id is actually visible: it appears in no page's front-matter. `folder children` follows pagination and reports each child's type, since a folder holds mixed content (pages, sub-folders, whiteboards, databases, embeds).

  `confluence search --cql "<query>"` runs a CQL query — the only way to find content by title or by parent, as there is no children-by-title endpoint. It sits at the top level rather than under `page` because CQL matches any content type.

  Request the OAuth scopes these endpoints need: `read:folder:confluence`, `write:folder:confluence`, `read:hierarchical-content:confluence` (direct children) and `read:content-details:confluence` (CQL search). They are requested on every `confluence auth login`, so add them to the OAuth app **before** logging in again — Atlassian rejects an authorization request naming a scope the app does not enable, which makes `auth login` itself fail at the authorize step. Existing tokens keep working for page and attachment commands until then; `folder` and `search` fail with 401/403 until the re-login lands. The scopes are kept in a separate `CONFLUENCE_FOLDER_SCOPES` constant so control-center, which shares `CONFLUENCE_SCOPES` for its own sign-in, keeps requesting only what it uses.

  Add `confluence auth manage`, which opens the Developer Console app list and prints the scopes to enable. It opens the list rather than the app itself because the console addresses an app by an id that is not the OAuth client id, and the client id is all this CLI stores. Both it and `auth create` derive the printed scopes from the constant `auth login` reads, so the setup instructions cannot drift from what login requests — the previous hardcoded list in `auth create` had already fallen behind the attachment scopes.

  `folder` and `search` refuse a site mismatch rather than acting on the wrong site. Content ids are per-site, so a `--base-url` disagreeing with the URL, a `--parent` pasted from another site, and — under OAuth — a `--base-url` that is not the active profile's site are all rejected. The OAuth case is the one that bites: those requests route by the profile's cloud id and ignore `--base-url` entirely, so `folder create --base-url site-a` while signed in to site B would otherwise create the folder on site B with no warning.

  Accept a folder's `createdAt` as epoch milliseconds. The v2 folder endpoints return a number there even though the upstream spec declares an ISO-8601 string and every other content type honours it — so before this, `folder get` and `folder create` failed to decode every real folder. The spec patch widens the generated schema to accept both shapes and the client normalizes to ISO-8601, so callers see one representation.

  Patch the Confluence v2 spec so `FolderSingle.position`/`parentId`/`parentType` and `ChildrenResponse.childPosition` generate as nullable rather than `never`. The generator turns the upstream `{"type": "integer", "nullable": true}` shape into `never`, so a folder or child payload carrying any of these fields failed the generated decode before the response reached the caller — the same fix already applied to `Page`, `PageBulk` and `ChildPage`.

- [#366](https://github.com/knpkv/npm/pull/366) [`b08ca20`](https://github.com/knpkv/npm/commit/b08ca2004b3efcd72a695b44c72b56dae20afdfd) Thanks [@konopkov](https://github.com/konopkov)! - Add `jira version create` and `jira issue edit`, closing the two gaps that forced release scaffolding out of the CLI.

  `jira version create --project <KEY> --name <NAME>` opens a new unreleased version, optionally with `--description`, `--start-date` and `--release-date`. The project key is resolved to the numeric `projectId` the endpoint requires, and dates are validated as ISO 8601 locally so a bad one names its own flag instead of returning an unattributed 400.

  `jira issue edit <KEY>` edits fix versions and labels. Both fields are sets, so the incremental flags — `--add-fix-version`, `--remove-fix-version`, `--add-label`, `--remove-label` — are the ones to reach for: they go through Jira's `update` verb, which applies server-side and cannot clobber a concurrent edit. The replacing forms (`--fix-version`, `--label`) are still available and say in their help that they drop anything not listed. Passing both forms for one field is refused up front, because Jira's own error for that case does not name the offending field.

- [#370](https://github.com/knpkv/npm/pull/370) [`27d2ca1`](https://github.com/knpkv/npm/commit/27d2ca18b0c0b0f8a252d461c0aaf10eb92e9ffc) Thanks [@konopkov](https://github.com/konopkov)! - Enforce the complete anti-slop rule set with zero accepted diagnostics and update affected APIs and implementations to satisfy the required contracts.

### Patch Changes

- [#361](https://github.com/knpkv/npm/pull/361) [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2) Thanks [@konopkov](https://github.com/konopkov)! - Update Effect and effect-qb, migrate schema-tagged errors to the current Effect API, and adopt the dialect-scoped SQLite function and type APIs introduced by effect-qb 0.22.

## 0.2.3

### Patch Changes

- [#125](https://github.com/knpkv/npm/pull/125) [`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade the workspace to Effect 4.0.0-beta.98 and current compatible dependencies. Replace ad hoc object guards with Effect Predicate helpers and migrate retry schedules to the current Schedule API.

## 0.2.2

### Patch Changes

- [#103](https://github.com/knpkv/npm/pull/103) [`477e4c6`](https://github.com/knpkv/npm/commit/477e4c60fa5c501883be6c03629da5a3cc91444c) Thanks [@konopkov](https://github.com/konopkov)! - Add shared Atlassian auth profile storage for multi-account and multi-site OAuth use.

  Jira and Confluence now expose `auth profiles`, `auth use <profile>`, and `auth remove <profile>` commands backed by shared profile management in `@knpkv/atlassian-common`. Confluence also migrates existing legacy auth/config files on first use. Agent skills and docs now describe the profile commands and active-profile checks.

- [#105](https://github.com/knpkv/npm/pull/105) [`a3a4d3a`](https://github.com/knpkv/npm/commit/a3a4d3a14fafe235bc901ed5015bb9bd82c59281) Thanks [@konopkov](https://github.com/konopkov)! - Add a unified Atlassian profile manager CLI with cross-tool profile listing, selection, diagnostics, token refresh, and scope validation helpers.

  Update bundled Jira, Confluence, and Jira Clockify agent skills to recommend the unified profile diagnostics workflow.

## 0.2.1

### Patch Changes

- [#99](https://github.com/knpkv/npm/pull/99) [`59478b0`](https://github.com/knpkv/npm/commit/59478b0d059d359feaf38222e5e55f748ee389d7) Thanks [@konopkov](https://github.com/konopkov)! - Refactor CLI command surfaces around resource-first groups and remove the legacy top-level aliases.

  - Jira issue reads now live under `jira issue get` and `jira issue search`; version reads and writes use `jira version get`, `jira version update`, and `jira version related-work`.
  - Confluence workspace setup now uses `confluence workspace clone`, page operations use `confluence page`, and sync/git-backed operations use `confluence sync`.
  - JCF timer operations now use `jcf timer`, ticket listing uses `jcf issue list`, and reconciliation uses `jcf sync reconcile`.
  - Agent skills and product-local skill copies now document the same canonical commands.

## 0.2.0

### Minor Changes

- [#81](https://github.com/knpkv/npm/pull/81) [`19c1538`](https://github.com/knpkv/npm/commit/19c153835bc198b9e407a013c16775c3fb7eb357) Thanks [@konopkov](https://github.com/konopkov)! - Ship agent skills alongside each CLI package and add an installer package plus per-CLI `skills install` commands for Codex and Claude.

### Patch Changes

- [#84](https://github.com/knpkv/npm/pull/84) [`c697d3c`](https://github.com/knpkv/npm/commit/c697d3c4ab779f14f017d3ec8fc8d1bffa1493b5) Thanks [@konopkov](https://github.com/konopkov)! - Expose source types so workspace CLI packages can build before `@knpkv/agent-skills` has emitted `dist` declarations.
