# @knpkv/atlassian-common

## 1.4.0

### Minor Changes

- [#358](https://github.com/knpkv/npm/pull/358) [`503d345`](https://github.com/knpkv/npm/commit/503d3459b419a3c9fd366715d5916e41086f493d) Thanks [@konopkov](https://github.com/konopkov)! - Add `OAuthError.status` and `OAuthError.errorCode`, and make
  `refreshActiveProfiles`' token rotation atomic and bounded.

  `OAuthError` now carries the HTTP `status` when the provider actually answered,
  plus the OAuth 2.0 `errorCode` from the response body (RFC 6749 §5.2) when it is
  parseable. Both are absent for transport failures, timeouts and interruptions —
  cases where no response arrived and nothing can be concluded about the
  credential. `refreshToken` populates them on a non-2xx response.

  They exist so callers can tell "the provider rejected this token" from "we never
  found out", which is the difference between correctly forcing a re-login and
  destroying a working credential. Status alone is too coarse: `400` covers
  `invalid_client` and `invalid_request`, which indict the request rather than the
  token, so `@knpkv/jira-cli` and `@knpkv/confluence-to-markdown` delete only on
  `400 invalid_grant` or a `403` revocation, leaving `429`, `408`, middlebox
  replies and unparseable bodies alone.

  `refreshActiveProfiles` performed the same rotate-then-persist sequence as
  `@knpkv/jira-cli`'s `JiraAuth`: `refreshToken(...)` followed by a separate,
  interruptible `saveProfileToken(...)`. Atlassian rotates refresh tokens, so an
  interrupt between the two spends the stored credential without persisting its
  replacement, and the next refresh fails — the user is silently logged out of
  that profile. The grant and the persist now share one `Effect.uninterruptible`
  region.

  That region carries its own 30s deadline. An uninterruptible region with no
  bound of its own absorbs SIGINT/SIGTERM entirely, since `runMain`'s handlers do
  nothing but interrupt the main fiber, so `atlassian auth refresh` would have
  stopped answering Ctrl-C against a stalled token endpoint. A deadline forked
  inside the region is itself interruptible, so it does bound it.

  Covered by a test asserting an interrupt mid-rotation still persists the
  replacement token.

- [#366](https://github.com/knpkv/npm/pull/366) [`b08ca20`](https://github.com/knpkv/npm/commit/b08ca2004b3efcd72a695b44c72b56dae20afdfd) Thanks [@konopkov](https://github.com/konopkov)! - Add `confluence folder` and `confluence search`, so folders and content lookup no longer need the Confluence UI or a separate MCP client.

  `folder get`, `folder children` and `folder create` cover the container the page commands cannot address — `/pages/{id}` 404s on a folder id and vice versa. `folder get` and `folder children` accept either `--folder-id` or `--url`, and a folder URL pasted into either is read for its id, because the URL bar is the only place a folder id is actually visible: it appears in no page's front-matter. `folder children` follows pagination and reports each child's type, since a folder holds mixed content (pages, sub-folders, whiteboards, databases, embeds).

  `confluence search --cql "<query>"` runs a CQL query — the only way to find content by title or by parent, as there is no children-by-title endpoint. It sits at the top level rather than under `page` because CQL matches any content type.

  Request the OAuth scopes these endpoints need: `read:folder:confluence`, `write:folder:confluence`, `read:hierarchical-content:confluence` (direct children) and `read:content-details:confluence` (CQL search). They are requested on every `confluence auth login`, so add them to the OAuth app **before** logging in again — Atlassian rejects an authorization request naming a scope the app does not enable, which makes `auth login` itself fail at the authorize step. Existing tokens keep working for page and attachment commands until then; `folder` and `search` fail with 401/403 until the re-login lands. The scopes are kept in a separate `CONFLUENCE_FOLDER_SCOPES` constant so control-center, which shares `CONFLUENCE_SCOPES` for its own sign-in, keeps requesting only what it uses.

  Add `confluence auth manage`, which opens the Developer Console app list and prints the scopes to enable. It opens the list rather than the app itself because the console addresses an app by an id that is not the OAuth client id, and the client id is all this CLI stores. Both it and `auth create` derive the printed scopes from the constant `auth login` reads, so the setup instructions cannot drift from what login requests — the previous hardcoded list in `auth create` had already fallen behind the attachment scopes.

  `folder` and `search` refuse a site mismatch rather than acting on the wrong site. Content ids are per-site, so a `--base-url` disagreeing with the URL, a `--parent` pasted from another site, and — under OAuth — a `--base-url` that is not the active profile's site are all rejected. The OAuth case is the one that bites: those requests route by the profile's cloud id and ignore `--base-url` entirely, so `folder create --base-url site-a` while signed in to site B would otherwise create the folder on site B with no warning.

  Accept a folder's `createdAt` as epoch milliseconds. The v2 folder endpoints return a number there even though the upstream spec declares an ISO-8601 string and every other content type honours it — so before this, `folder get` and `folder create` failed to decode every real folder. The spec patch widens the generated schema to accept both shapes and the client normalizes to ISO-8601, so callers see one representation.

  Patch the Confluence v2 spec so `FolderSingle.position`/`parentId`/`parentType` and `ChildrenResponse.childPosition` generate as nullable rather than `never`. The generator turns the upstream `{"type": "integer", "nullable": true}` shape into `never`, so a folder or child payload carrying any of these fields failed the generated decode before the response reached the caller — the same fix already applied to `Page`, `PageBulk` and `ChildPage`.

- [#370](https://github.com/knpkv/npm/pull/370) [`27d2ca1`](https://github.com/knpkv/npm/commit/27d2ca18b0c0b0f8a252d461c0aaf10eb92e9ffc) Thanks [@konopkov](https://github.com/konopkov)! - Enforce the complete anti-slop rule set with zero accepted diagnostics and update affected APIs and implementations to satisfy the required contracts.

### Patch Changes

- [#361](https://github.com/knpkv/npm/pull/361) [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2) Thanks [@konopkov](https://github.com/konopkov)! - Update Effect and effect-qb, migrate schema-tagged errors to the current Effect API, and adopt the dialect-scoped SQLite function and type APIs introduced by effect-qb 0.22.

## 1.3.0

### Minor Changes

- [#343](https://github.com/knpkv/npm/pull/343) [`4def7db`](https://github.com/knpkv/npm/commit/4def7db2f400cf68218262994d67ed90a7154bf1) Thanks [@konopkov](https://github.com/konopkov)! - Align runtime ownership, cancellation, caching, time, failure handling, polling,
  decoding, and executable entrypoints with Effect v4 idioms. Expose clock-injected
  Atlassian token construction and expiry helpers, and enable workspace-wide
  Effect diagnostics and prevention checks.

### Patch Changes

- [#339](https://github.com/knpkv/npm/pull/339) [`a9d5408`](https://github.com/knpkv/npm/commit/a9d54085f6fc25cde1d5b298f50cb6e06e2bc93f) Thanks [@konopkov](https://github.com/konopkov)! - Reconcile Control Center's Jira capability boundary with provider-enforced revision guarantees, expose the proposal-only Jira OAuth scope contract, and document the M5.6 release-gate evidence workflow.

## 1.2.0

### Minor Changes

- [#181](https://github.com/knpkv/npm/pull/181) [`665cecb`](https://github.com/knpkv/npm/commit/665cecbc3d5f79f9083acb1b393ace9a8ec0b1b8) Thanks [@konopkov](https://github.com/konopkov)! - Prefer one shared local Atlassian OAuth profile when connecting Jira and Confluence, while retaining API tokens as an explicit fallback.

- [#187](https://github.com/knpkv/npm/pull/187) [`1bba5c2`](https://github.com/knpkv/npm/commit/1bba5c282684553fbc670e6dcf2960e8a4e200ed) Thanks [@konopkov](https://github.com/konopkov)! - Add reusable application callback URLs to Atlassian OAuth helpers and an OAuth-first Control Center connection flow with PKCE, session-bound single-use grants, explicit site selection, and shared Jira/Confluence local profiles.

### Patch Changes

- [#125](https://github.com/knpkv/npm/pull/125) [`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade the workspace to Effect 4.0.0-beta.98 and current compatible dependencies. Replace ad hoc object guards with Effect Predicate helpers and migrate retry schedules to the current Schedule API.

## 1.1.0

### Minor Changes

- [#114](https://github.com/knpkv/npm/pull/114) [`904d3d7`](https://github.com/knpkv/npm/commit/904d3d75948d94558484094cf225b5ea6585663e) Thanks [@konopkov](https://github.com/konopkov)! - Add Jira and Confluence attachment support.

  - Add shared attachment rendering and placeholder replacement helpers.
  - Support multipart attachment upload calls in Jira and Confluence API clients.
  - Render Jira attachments as inline image previews or links with hidden attachment metadata.
  - Resolve Confluence media attachments to visible Markdown previews while preserving native media ADF identity.
  - Add explicit Jira and Confluence attachment upload commands with optional Markdown placeholder insertion.

## 1.0.0

### Major Changes

- [#109](https://github.com/knpkv/npm/pull/109) [`734f891`](https://github.com/knpkv/npm/commit/734f8911d930cedc8642d5e2bd9fa73c76a99054) Thanks [@konopkov](https://github.com/konopkov)! - BREAKING: PKCE and auth UUID helpers now use Effect's platform `Crypto` service.

  `generateCodeVerifier()` now returns an `Effect` instead of a string, and
  `computeCodeChallenge()` / `generateUUID()` now require a `Crypto.Crypto` service
  in their Effect environment. Provide an appropriate platform layer such as
  `@effect/platform-node/NodeCrypto.layer` at the runtime edge.

## 0.4.0

### Minor Changes

- [#103](https://github.com/knpkv/npm/pull/103) [`477e4c6`](https://github.com/knpkv/npm/commit/477e4c60fa5c501883be6c03629da5a3cc91444c) Thanks [@konopkov](https://github.com/konopkov)! - Add shared Atlassian auth profile storage for multi-account and multi-site OAuth use.

  Jira and Confluence now expose `auth profiles`, `auth use <profile>`, and `auth remove <profile>` commands backed by shared profile management in `@knpkv/atlassian-common`. Confluence also migrates existing legacy auth/config files on first use. Agent skills and docs now describe the profile commands and active-profile checks.

- [#105](https://github.com/knpkv/npm/pull/105) [`a3a4d3a`](https://github.com/knpkv/npm/commit/a3a4d3a14fafe235bc901ed5015bb9bd82c59281) Thanks [@konopkov](https://github.com/konopkov)! - Add a unified Atlassian profile manager CLI with cross-tool profile listing, selection, diagnostics, token refresh, and scope validation helpers.

  Update bundled Jira, Confluence, and Jira Clockify agent skills to recommend the unified profile diagnostics workflow.

## 0.3.0

### Minor Changes

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

## 0.2.0

### Minor Changes

- [#61](https://github.com/knpkv/npm/pull/61) [`fc7be8f`](https://github.com/knpkv/npm/commit/fc7be8ffaf5b6b094c7f81551e8ace6f2a8f2c4c) Thanks @konopkov! - feat: add jira-api-client and atlassian-common packages
  - New @knpkv/atlassian-common: shared AST types, serializers, auth, and config
  - New @knpkv/jira-api-client: Effect-based Jira REST API client (openapi-gen)
  - Updated @knpkv/confluence-api-client: regenerated with openapi-gen
  - Updated @knpkv/confluence-to-markdown: use new generated API client
