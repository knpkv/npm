# @knpkv/codecommit-core

## 0.10.0

### Minor Changes

- [#262](https://github.com/knpkv/npm/pull/262) [`dd0163e`](https://github.com/knpkv/npm/commit/dd0163ec002ae8abbce0b19df61431b3a4701314) Thanks [@konopkov](https://github.com/konopkov)! - Add immutable CodeCommit pull-request review actions with governed proposals, durable provider receipts, and non-replaying reconciliation.

### Patch Changes

- [#259](https://github.com/knpkv/npm/pull/259) [`7da266b`](https://github.com/knpkv/npm/commit/7da266bbb8cbf47f0f826274cc890384011e08e0) Thanks [@konopkov](https://github.com/konopkov)! - Make CodeCommit manual synchronization resilient to real provider responses.
  Pull-request decoding now normalizes untrimmed titles and tolerates omitted
  author identities instead of failing the whole stream, and schema-decode
  failures are surfaced in logs with the offending field. Reduce the
  GetPullRequest hydration fan-out to stay under CodeCommit's throttle ceiling,
  and honor a bounded provider Retry-After when retrying rate-limited syncs.
  Correct the manual-sync timestamp rendering and show an explicit in-progress
  state in the services UI.

## 0.9.1

### Patch Changes

- [#251](https://github.com/knpkv/npm/pull/251) [`bf74411`](https://github.com/knpkv/npm/commit/bf744117e07b84b28e139ee131687fd36d080e3e) Thanks [@konopkov](https://github.com/konopkov)! - Patch two high-severity transitive dependency advisories via `pnpm-workspace.yaml`
  overrides:

  - **fast-uri** — bump `<=3.1.3` to `^3.1.4` (GHSA-v2hh-gcrm-f6hx: host confusion
    via literal backslash authority delimiter). Pulled in through `ajv`; affects
    `@knpkv/confluence-to-markdown` and `@knpkv/rly`.
  - **fast-xml-parser** — bump the `@distilled.cloud/aws` override from `^5.3.4` to
    `^5.10.1` (GHSA-8r6m-32jq-jx6q: repeated DOCTYPE declarations reset entity
    expansion limits). Affects `@knpkv/codecommit-core` and `@knpkv/control-center`.

  No source changes; `pnpm audit --prod && pnpm audit --dev` now reports no known
  vulnerabilities.

## 0.9.0

### Minor Changes

- [#244](https://github.com/knpkv/npm/pull/244) [`459962f`](https://github.com/knpkv/npm/commit/459962f2d71a8d36ffdb5fd4cf1b70d413973445) Thanks [@konopkov](https://github.com/konopkov)! - Add bounded AWS CodeCommit and CodePipeline resource discovery to Control Center onboarding, including verified account identity, partial-permission handling, searchable selection with manual fallback, and the manual synchronization controls for supported service connections.

- [#154](https://github.com/knpkv/npm/pull/154) [`fe27e3c`](https://github.com/knpkv/npm/commit/fe27e3c74630d52b25d840e10fe8ea58b38b6b65) Thanks [@konopkov](https://github.com/konopkov)! - Add the Schema-decoded CodeCommit pull-request and changed-file read boundary and a read-only Control Center adapter with cursor pagination.

### Patch Changes

- [#179](https://github.com/knpkv/npm/pull/179) [`41565ba`](https://github.com/knpkv/npm/commit/41565ba9d1adf50abf36620dec1e9dee516f5133) Thanks [@konopkov](https://github.com/konopkov)! - Expose credential-free AWS CLI profile discovery from CodeCommit Core and use
  the shared profile catalogue when configuring CodeCommit and CodePipeline in
  Control Center.

- [#176](https://github.com/knpkv/npm/pull/176) [`f2c7c3f`](https://github.com/knpkv/npm/commit/f2c7c3fb1acff1907c7c9fbeb613775eab5c5c2b) Thanks [@konopkov](https://github.com/konopkov)! - Add Schema-decoded, size-bounded CodeCommit blob reads with typed provider-limit metadata.

- [#177](https://github.com/knpkv/npm/pull/177) [`e1d121d`](https://github.com/knpkv/npm/commit/e1d121d5782f756d0a8f271d59a39a3b98f42c38) Thanks [@konopkov](https://github.com/konopkov)! - Add conservative binary and generated-file classification for bounded CodeCommit blobs.

- [#226](https://github.com/knpkv/npm/pull/226) [`0df499b`](https://github.com/knpkv/npm/commit/0df499bb3241a4efa9a4179f649233943310f47d) Thanks [@konopkov](https://github.com/konopkov)! - Move live AWS reads to the maintained Effect 4-compatible Distilled AWS package.

- [#125](https://github.com/knpkv/npm/pull/125) [`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade the workspace to Effect 4.0.0-beta.98 and current compatible dependencies. Replace ad hoc object guards with Effect Predicate helpers and migrate retry schedules to the current Schedule API.

## 0.8.0

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

## 0.7.1

### Patch Changes

- [#63](https://github.com/knpkv/npm/pull/63) [`acf502b`](https://github.com/knpkv/npm/commit/acf502bd7f36d6c69db3da0f9b4613af5e5de71b) Thanks @konopkov! - fix(codecommit-core): coerce `NumberOfApprovalsNeeded` from string to number

  AWS CodeCommit returns `NumberOfApprovalsNeeded` inconsistently as either a number or a string. `parseRuleContent` now coerces with `Number()` and falls back to `1` when the value is non-numeric, so `requiredApprovals` is always a number.

## 0.7.0

### Minor Changes

- [#55](https://github.com/knpkv/npm/pull/55) [`3ce2182`](https://github.com/knpkv/npm/commit/3ce21821504c75b294555163a660bf02010a4bde) Thanks @konopkov! - PR approvers: approval rules, review UI, desktop notifications
  - ApprovalRule domain model with needsMyReview, diffApprovalPools, approval_requested/review_reminder notifications
  - Approval rule CRUD via CodeCommitApprovers format with cross-account SSO support (repoAccountId from getRepository)
  - Cache: 3 migrations (approval_rules, approved_by_arns, repo_account_id)
  - SSE: pendingReviewCount, approvalRules + approvedByArns in wire schema
  - UI: header review badge, Review filter, required/optional approvers cards with suggested users + optimistic spinners
  - Desktop notifications with click-to-navigate, dedup, review reminders (configurable interval)
  - Notification settings tab (desktop toggle, reminder interval)
  - Audit: clear all logs, Statement.and parameterized queries, disabled by default
  - Noise reduction: removed transient SSO/assume notifications, toast suppression for title/description changes

## 0.6.0

### Minor Changes

- [#53](https://github.com/knpkv/npm/pull/53) [`ed64b64`](https://github.com/knpkv/npm/commit/ed64b64ae5e8e27a6629a72807e35299826a1372) Thanks @konopkov! - feat: API permissions gate and audit log

## 0.5.1

### Patch Changes

- [#47](https://github.com/knpkv/npm/pull/47) [`3932903`](https://github.com/knpkv/npm/commit/3932903aefc932fc74fcd599e7cd7850a0a3f57c) Thanks @konopkov! - Add statistics dashboard page and improve PR list filtering with default status:open filter

## 0.5.0

### Minor Changes

- [#44](https://github.com/knpkv/npm/pull/44) [`e9c349f`](https://github.com/knpkv/npm/commit/e9c349fac3d2214a94aedaa3aaac40d0ea23d081) Thanks @konopkov! - Add code sandbox feature with Docker-based environments, plugin system, and web UI

## 0.4.0

### Minor Changes

- [#41](https://github.com/knpkv/npm/pull/41) [`c94efb9`](https://github.com/knpkv/npm/commit/c94efb90455b6e0049f80bd0d43b2bfc4f61de7b) Thanks @konopkov! - Add local SQLite cache layer with persistent notifications, PR subscriptions, per-PR refresh, and enriched notification messages

## 0.3.0

### Minor Changes

- [#39](https://github.com/knpkv/npm/pull/39) [`70bc0e8`](https://github.com/knpkv/npm/commit/70bc0e8deda4e2bc97c6eb7afcabb7274608c629) Thanks @konopkov! - feat: settings page with notifications and config management
  - Add settings page (accounts, theme, config, about) to web and TUI
  - Add notification profile field to NotificationItem domain model
  - Add config backup/reset/validate with atomic backup (tmp+rename)
  - Add SSO login/logout endpoints with semaphore and timeout
  - Add notifications page with auth-error detection and inline SSO actions
  - Persist theme to localStorage, debounce account toggle saves
  - Add ARIA roles to web settings tabs
  - Fix useMemo side-effect, exit timeout cleanup, CORS credentials

## 0.2.0

### Minor Changes

- [`f3cd927`](https://github.com/knpkv/npm/commit/f3cd9274fb70f9428e2bc27d4c3d601a985a7adf) Thanks @konopkov! - feat: PR health score with comments and hot filter

## 0.1.2

### Patch Changes

- [#35](https://github.com/knpkv/npm/pull/35) [`c0ba0c5`](https://github.com/knpkv/npm/commit/c0ba0c51c49cc30ab6a5a9d7633c0f5cfa036d9c) Thanks @konopkov! - fix: use workspace:^ for proper version resolution on publish

## 0.1.1

### Patch Changes

- [#33](https://github.com/knpkv/npm/pull/33) [`5da23ba`](https://github.com/knpkv/npm/commit/5da23ba57f670de8c0c5aa308992450072be3ede) Thanks @konopkov! - fix: packaging fixes for npm publish
  - Set publishConfig.access to public
  - Add publishConfig.exports to codecommit-core
  - Add prepack scripts
  - Pin distilled-aws to 0.0.21

## 0.1.0

### Minor Changes

- [#27](https://github.com/knpkv/npm/pull/27) [`d27338d`](https://github.com/knpkv/npm/commit/d27338d54098a07edc7eb17b33f1fe77cfa2cd35) Thanks @konopkov! - feat: add codecommit packages for browsing AWS CodeCommit PRs
  - `codecommit-core`: domain model, PRService, ConfigService, AwsClient, branded types
  - `codecommit`: TUI with OpenTUI components, atom state, 30+ themes, tests
  - `codecommit-web`: web UI with Effect HttpApi, SSE, shadcn/Tailwind
