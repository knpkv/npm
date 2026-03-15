# @knpkv/codecommit-core

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
