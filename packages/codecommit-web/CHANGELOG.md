# @knpkv/codecommit-web

## 0.16.0

### Minor Changes

- [#410](https://github.com/knpkv/npm/pull/410) [`161566b`](https://github.com/knpkv/npm/commit/161566bccefc349e99d39734c910605d85cf1866) Thanks [@konopkov](https://github.com/konopkov)! - Add Claude-native Relay review profiles and persist Relay settings immediately after save.

- [#399](https://github.com/knpkv/npm/pull/399) [`316eff1`](https://github.com/knpkv/npm/commit/316eff159bc44fa46d5d1ec68d4515990fb3d9a1) Thanks [@konopkov](https://github.com/konopkov)! - Prevent sandbox startup reconciliation races and preserve profile identity when an AWS account id is empty.

### Patch Changes

- Updated dependencies [[`161566b`](https://github.com/knpkv/npm/commit/161566bccefc349e99d39734c910605d85cf1866), [`e4fb297`](https://github.com/knpkv/npm/commit/e4fb2975fa5a23f679fda0e0921d6837c4b684aa), [`e4fb297`](https://github.com/knpkv/npm/commit/e4fb2975fa5a23f679fda0e0921d6837c4b684aa), [`1dcc473`](https://github.com/knpkv/npm/commit/1dcc473ebd14c2a4ac00d7fd67bf9a8d80201f66), [`316eff1`](https://github.com/knpkv/npm/commit/316eff159bc44fa46d5d1ec68d4515990fb3d9a1)]:
  - @knpkv/ai-claude@0.3.0
  - @knpkv/codecommit-core@0.16.0
  - @knpkv/rly@0.6.0
  - @knpkv/relay-product@0.1.1
  - @knpkv/review@0.2.2

## 0.15.0

### Minor Changes

- [#394](https://github.com/knpkv/npm/pull/394) [`dc18f2c`](https://github.com/knpkv/npm/commit/dc18f2c7149cdf6a0b4eee1461d41170311dd5fc) Thanks [@konopkov](https://github.com/konopkov)! - Preserve exact CodeCommit pull-request coordinates across cache, sandbox,
  notification, and review routes.

- [#390](https://github.com/knpkv/npm/pull/390) [`75ece0a`](https://github.com/knpkv/npm/commit/75ece0ab3d666488bc32820aeef56adb0873cead) Thanks [@konopkov](https://github.com/konopkov)! - Add one shared, collapsed Relay dock with durable pull-request threads, visible
  model and profile selection, and host-to-pull-request continuation.

### Patch Changes

- Updated dependencies [[`dc18f2c`](https://github.com/knpkv/npm/commit/dc18f2c7149cdf6a0b4eee1461d41170311dd5fc), [`75ece0a`](https://github.com/knpkv/npm/commit/75ece0ab3d666488bc32820aeef56adb0873cead), [`75ece0a`](https://github.com/knpkv/npm/commit/75ece0ab3d666488bc32820aeef56adb0873cead)]:
  - @knpkv/codecommit-core@0.15.0
  - @knpkv/relay-product@0.1.0
  - @knpkv/rly@0.5.0
  - @knpkv/review@0.2.1

## 0.14.0

### Minor Changes

- [#387](https://github.com/knpkv/npm/pull/387) [`4ad196f`](https://github.com/knpkv/npm/commit/4ad196f7fe5e6ed68b6646681123bc1f603979fa) Thanks [@konopkov](https://github.com/konopkov)! - Make Relay profiles own the review kind, skills, provider harness, and model across settings, execution, and restored sessions.

### Patch Changes

- Updated dependencies [[`4ad196f`](https://github.com/knpkv/npm/commit/4ad196f7fe5e6ed68b6646681123bc1f603979fa), [`6d42c7c`](https://github.com/knpkv/npm/commit/6d42c7ce69e8b9116df409ec79579bf45d380fad), [`8caea60`](https://github.com/knpkv/npm/commit/8caea601c147b8a1dd0ea9f20155f4e76ff6351e), [`7c982c9`](https://github.com/knpkv/npm/commit/7c982c9f0ec56a65adff1275182a30f43f0eb0ee), [`94ee004`](https://github.com/knpkv/npm/commit/94ee00487f0595cdc16fd8f1332689eb39ecfaf2), [`4ad196f`](https://github.com/knpkv/npm/commit/4ad196f7fe5e6ed68b6646681123bc1f603979fa), [`4ad196f`](https://github.com/knpkv/npm/commit/4ad196f7fe5e6ed68b6646681123bc1f603979fa)]:
  - @knpkv/ai-codex@0.4.0
  - @knpkv/codecommit-core@0.14.0
  - @knpkv/rly@0.4.1
  - @knpkv/review@0.2.0

## 0.13.0

### Minor Changes

- [#373](https://github.com/knpkv/npm/pull/373) [`9364cc5`](https://github.com/knpkv/npm/commit/9364cc5834eda7f57c7724b9cd7052b6c9f6f15d) Thanks [@konopkov](https://github.com/konopkov)! - Add streamed web Relay progress, configurable prompt-only review profiles and environment skills, reload-safe finding conversations and exact-head re-review, independently scrolling findings and replies, a collapsible changed-file hierarchy, local acknowledge/reject decisions, bidirectional comment-to-diff navigation, and permission-gated publication of accepted findings as native line comments or file-anchored PR comments.

### Patch Changes

- [#361](https://github.com/knpkv/npm/pull/361) [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade the workspace to Effect 4.0.0-rc.109, pin the vendored Effect reference to that exact upstream release, guard source/package alignment, and bound Control Center test concurrency for reliable CI execution.
- Updated dependencies [[`812468f`](https://github.com/knpkv/npm/commit/812468f8e98326f854b36df1bbc08095bd0c08b3), [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2), [`9364cc5`](https://github.com/knpkv/npm/commit/9364cc5834eda7f57c7724b9cd7052b6c9f6f15d)]:
  - @knpkv/rly@0.4.0
  - @knpkv/ai-codex@0.3.1
  - @knpkv/codecommit-core@0.13.0

## 0.12.0

### Minor Changes

- [#367](https://github.com/knpkv/npm/pull/367) [`b0ceb6e`](https://github.com/knpkv/npm/commit/b0ceb6ec9957c1be3de8700168e7767a3eb68203) Thanks [@konopkov](https://github.com/konopkov)! - Add an exact-revision CodeCommit diff workbench backed by the diffs.com renderer, including bounded text rendering and file-mode changes, plus permission-gated ephemeral prompt-only Relay reviews with full, security, tests, and explanation focuses.

- [#359](https://github.com/knpkv/npm/pull/359) [`756ba26`](https://github.com/knpkv/npm/commit/756ba26b10c663b6768016c92ef7eab3da4f99d4) Thanks [@konopkov](https://github.com/konopkov)! - Add an "Open in CodeCommit" action to the TUI Changes tab, next to the Neovim
  and VS Code shortcuts. Uppercase `C` opens the selected file in the AWS
  CodeCommit console.

  The link always names an exact commit, so the opened page cannot drift to a
  newer head: a surviving file resolves to the reviewed source commit, and a
  deleted file resolves to the destination commit, the only revision in the review
  where the console can still render it. Unlike the editor shortcuts the action
  reads the provider directly, so it needs no local checkout. The console hostname
  comes from the region's AWS partition, so China and GovCloud accounts reach their
  own console domain, and an isolated-partition region is reported as unsupported
  instead of being sent to a commercial URL that cannot resolve.

  The link is copied to the clipboard when a clipboard tool exists and is then
  handed to Granted's `assume`, which
  is what turns the profile into a federated console session; the TUI yields the
  terminal for the run so an expired SSO prompt stays visible and answerable. A
  missing `assume` executable is reported as its own case — a dialog naming the
  install and showing the link — rather than as one more failed
  attempt, because there is nothing to retry until it is installed and an
  unauthenticated console link only reaches a sign-in page.

  Ctrl-C during a terminal handover now ends the child instead of the session. A
  suspended renderer leaves the tty in cooked mode with `ISIG` enabled, so the
  keystroke raised `SIGINT` on this process, where `runMain` interrupted the main
  fiber and exited — discarding findings, dispositions and conversations, which are
  component state. The session's interrupt teardown is now bracketed across
  suspend/resume and `assume` runs in the terminal's foreground process group, so the
  signal reaches the child. `SIGTERM` is deliberately left unbracketed so another
  shell can still end the process, and Neovim is unaffected because raw mode makes
  Ctrl-C a keypress rather than a signal.

  `ChildEnv.profileScopedEnv` now takes the environment the child will inherit and
  tombstones the spellings actually present, not only the canonical names. Windows
  environment names are case-insensitive, so an ambient `Aws_Access_Key_Id` used to
  survive beside the `AWS_ACCESS_KEY_ID` tombstone and outrank the requested profile.
  The spawn stays `extendEnv: true`, so `PATH` and every other inherited variable are
  untouched. `ChildEnv.HostEnvironment` is the service that supplies the inherited
  environment at a runtime call site.

  `@knpkv/codecommit-web` takes a minor bump rather than a patch: it re-exports
  `makeServer`, `makeCodeCommitServer` and `CodeCommitServerLive`, and their emitted
  declarations now carry the `ChildEnv.HostEnvironment` requirement, so a downstream
  layer composition that satisfied them before will no longer compile without it.

  All five profile-scoped spawns now supply it — both `assume` paths, the sandbox
  clone, and the exact-head Git commands — with the layer bound at each executable
  boundary (the CLI, the TUI program, and the web server), since that is the only place
  permitted to read the host process.

- [#360](https://github.com/knpkv/npm/pull/360) [`4dd1a0a`](https://github.com/knpkv/npm/commit/4dd1a0a5151b26fd13de29b8297c788bb0302e94) Thanks [@konopkov](https://github.com/konopkov)! - Redesign the CodeCommit web app around the shared Control Center visual system.
  The review queue, pull-request workspace, and sandbox surfaces now use the
  `@knpkv/rly` foundations, typography, state language, controls, and responsive
  layout while preserving the existing review and lifecycle workflows.

- [#357](https://github.com/knpkv/npm/pull/357) [`77e3257`](https://github.com/knpkv/npm/commit/77e3257743aacfaf9e11e016a60206f416c5fe79) Thanks [@konopkov](https://github.com/konopkov)! - Secure local control planes and CI credential boundaries. CodeCommit web now
  uses a process-scoped owner session with CSRF protection and loopback-only
  listeners; review sandboxes use authenticated loopback code-server instances,
  digest-pinned images, constrained mounts, non-root execution, and dropped
  capabilities. OAuth callback listeners validate state before accepting terminal
  outcomes and bind explicitly to loopback. GitHub workflows pin external actions
  to immutable commits and keep long-lived Atlassian credentials out of pull
  request execution.

- [#370](https://github.com/knpkv/npm/pull/370) [`27d2ca1`](https://github.com/knpkv/npm/commit/27d2ca18b0c0b0f8a252d461c0aaf10eb92e9ffc) Thanks [@konopkov](https://github.com/konopkov)! - Enforce the complete anti-slop rule set with zero accepted diagnostics and update affected APIs and implementations to satisfy the required contracts.

### Patch Changes

- [#361](https://github.com/knpkv/npm/pull/361) [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2) Thanks [@konopkov](https://github.com/konopkov)! - Update Effect and effect-qb, migrate schema-tagged errors to the current Effect API, and adopt the dialect-scoped SQLite function and type APIs introduced by effect-qb 0.22.
- Updated dependencies [[`b0ceb6e`](https://github.com/knpkv/npm/commit/b0ceb6ec9957c1be3de8700168e7767a3eb68203), [`d73b113`](https://github.com/knpkv/npm/commit/d73b113d6d49a9ffa9e553312c98d00e793af325), [`756ba26`](https://github.com/knpkv/npm/commit/756ba26b10c663b6768016c92ef7eab3da4f99d4), [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2), [`316c383`](https://github.com/knpkv/npm/commit/316c3832c64ce159b7b18d9be3d58bf355c20b8a), [`77e3257`](https://github.com/knpkv/npm/commit/77e3257743aacfaf9e11e016a60206f416c5fe79), [`27d2ca1`](https://github.com/knpkv/npm/commit/27d2ca18b0c0b0f8a252d461c0aaf10eb92e9ffc)]:
  - @knpkv/codecommit-core@0.12.0
  - @knpkv/ai-codex@0.3.0
  - @knpkv/rly@0.3.0

## 0.11.4

### Patch Changes

- Updated dependencies [[`b4e09d6`](https://github.com/knpkv/npm/commit/b4e09d659a56b8213767ffda06dffb75fa74d489)]:
  - @knpkv/codecommit-core@0.11.0

## 0.11.3

### Patch Changes

- [#343](https://github.com/knpkv/npm/pull/343) [`4def7db`](https://github.com/knpkv/npm/commit/4def7db2f400cf68218262994d67ed90a7154bf1) Thanks [@konopkov](https://github.com/konopkov)! - Align runtime ownership, cancellation, caching, time, failure handling, polling,
  decoding, and executable entrypoints with Effect v4 idioms. Expose clock-injected
  Atlassian token construction and expiry helpers, and enable workspace-wide
  Effect diagnostics and prevention checks.
- Updated dependencies [[`f35e10d`](https://github.com/knpkv/npm/commit/f35e10dcf2dc7ac50538621904f7acd4420956e6), [`4def7db`](https://github.com/knpkv/npm/commit/4def7db2f400cf68218262994d67ed90a7154bf1)]:
  - @knpkv/codecommit-core@0.10.1

## 0.11.2

### Patch Changes

- [#309](https://github.com/knpkv/npm/pull/309) [`f804a71`](https://github.com/knpkv/npm/commit/f804a7102bdd7bb8b9732e5e5d9cb9bf66e6c00f) Thanks [@konopkov](https://github.com/konopkov)! - Fix `NotFound: ChildProcess.spawn` when opening a PR in the AWS console or cloning into a review sandbox. `ChildProcess.make` replaces the child environment unless `extendEnv` is set, so passing only `GRANTED_ALIAS_CONFIGURED` or the `AWS_PROFILE` overrides dropped `PATH` and the `assume`, `git`, and `aws` executables could no longer be resolved.

  Inheriting the caller's environment also means inheriting its AWS credentials, which the credential chain resolves above profile configuration. Profile-scoped spawns now go through `ChildEnv.profileScopedEnv` so the requested profile and region stay authoritative instead of a sandbox clone silently authenticating as the host's identity.

  **Behaviour change.** These ambient variables are now removed from the child environment of the `assume` and sandbox-clone spawns:

  - static credentials — `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_SECURITY_TOKEN`, `AWS_CREDENTIAL_EXPIRATION`
  - web identity — `AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_SESSION_NAME`
  - region — `AWS_REGION`, `AWS_DEFAULT_REGION`

  If you relied on any of these to steer these commands, pass the value explicitly instead; the named profile now decides. `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` are deliberately preserved. `ChildEnv.ts` carries the authoritative list and the reasoning, including a documented Windows case-insensitivity limitation.

- Updated dependencies [[`dd0163e`](https://github.com/knpkv/npm/commit/dd0163ec002ae8abbce0b19df61431b3a4701314), [`7da266b`](https://github.com/knpkv/npm/commit/7da266bbb8cbf47f0f826274cc890384011e08e0), [`f804a71`](https://github.com/knpkv/npm/commit/f804a7102bdd7bb8b9732e5e5d9cb9bf66e6c00f), [`b97fd1b`](https://github.com/knpkv/npm/commit/b97fd1b2433bcaef600e5470e2ce92d7edc71f94)]:
  - @knpkv/codecommit-core@0.10.0

## 0.11.1

### Patch Changes

- [#125](https://github.com/knpkv/npm/pull/125) [`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade the workspace to Effect 4.0.0-beta.98 and current compatible dependencies. Replace ad hoc object guards with Effect Predicate helpers and migrate retry schedules to the current Schedule API.

- Updated dependencies [[`41565ba`](https://github.com/knpkv/npm/commit/41565ba9d1adf50abf36620dec1e9dee516f5133), [`459962f`](https://github.com/knpkv/npm/commit/459962f2d71a8d36ffdb5fd4cf1b70d413973445), [`f2c7c3f`](https://github.com/knpkv/npm/commit/f2c7c3fb1acff1907c7c9fbeb613775eab5c5c2b), [`e1d121d`](https://github.com/knpkv/npm/commit/e1d121d5782f756d0a8f271d59a39a3b98f42c38), [`0df499b`](https://github.com/knpkv/npm/commit/0df499bb3241a4efa9a4179f649233943310f47d), [`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43), [`fe27e3c`](https://github.com/knpkv/npm/commit/fe27e3c74630d52b25d840e10fe8ea58b38b6b65)]:
  - @knpkv/codecommit-core@0.9.0

## 0.11.0

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

### Patch Changes

- Updated dependencies [[`e3c3805`](https://github.com/knpkv/npm/commit/e3c3805ee527a6edb69ed91977c95c586b563ff9)]:
  - @knpkv/codecommit-core@0.8.0

## 0.10.0

### Minor Changes

- [#59](https://github.com/knpkv/npm/pull/59) [`0f58736`](https://github.com/knpkv/npm/commit/0f587363a1a7acb203f41a24b0cfe4861a2998c0) Thanks @konopkov! - Breathable UI redesign: sidebar filters, rolling status, recent activity
  - Card layout for PR rows with status dot badges, large health score, repo pill
  - Structured rolling status in header (phase-based: cache→fetch→comments→diffs→health)
  - Filter sidebar with mutually exclusive modes (Hot/All/Mine/Review), searchable combobox popovers, sortBy/groupBy query params
  - Recent Activity right aside with clickable PR links, filtered to PR notifications only
  - Full-width sidebar layout (left filters + main content + right activity)

## 0.9.1

### Patch Changes

- [#57](https://github.com/knpkv/npm/pull/57) [`3c731e9`](https://github.com/knpkv/npm/commit/3c731e94c71fe9a4fe05a84da1acbda6fe474a8c) Thanks @konopkov! - Approver discovery: discover all users (authors, approvers, commenters) not just ARN holders, auto-prefix CodeCommitApprovers:REPO_ACCT: so users type just a username

## 0.9.0

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

### Patch Changes

- Updated dependencies [[`3ce2182`](https://github.com/knpkv/npm/commit/3ce21821504c75b294555163a660bf02010a4bde)]:
  - @knpkv/codecommit-core@0.7.0

## 0.8.0

### Minor Changes

- [#53](https://github.com/knpkv/npm/pull/53) [`ed64b64`](https://github.com/knpkv/npm/commit/ed64b64ae5e8e27a6629a72807e35299826a1372) Thanks @konopkov! - feat: API permissions gate and audit log

### Patch Changes

- Updated dependencies [[`ed64b64`](https://github.com/knpkv/npm/commit/ed64b64ae5e8e27a6629a72807e35299826a1372)]:
  - @knpkv/codecommit-core@0.6.0

## 0.7.0

### Minor Changes

- [#51](https://github.com/knpkv/npm/pull/51) [`ada91ba`](https://github.com/knpkv/npm/commit/ada91bab4fe275cefe6aac1c061a0f7f16b1e000) Thanks @konopkov! - Gold star treatment for #1 contributor/commenter/approver in ranking charts

## 0.6.1

### Patch Changes

- [#49](https://github.com/knpkv/npm/pull/49) [`0f7d6e6`](https://github.com/knpkv/npm/commit/0f7d6e6b399d2e4da525c99b887a5762d3685157) Thanks @konopkov! - Fix status sub-filters leaking merged/closed PRs by splitting into orthogonal axes (approval, mergeability, lifecycle)

## 0.6.0

### Minor Changes

- [#47](https://github.com/knpkv/npm/pull/47) [`3932903`](https://github.com/knpkv/npm/commit/3932903aefc932fc74fcd599e7cd7850a0a3f57c) Thanks @konopkov! - Add statistics dashboard page and improve PR list filtering with default status:open filter

### Patch Changes

- Updated dependencies [[`3932903`](https://github.com/knpkv/npm/commit/3932903aefc932fc74fcd599e7cd7850a0a3f57c)]:
  - @knpkv/codecommit-core@0.5.1

## 0.5.0

### Minor Changes

- [#44](https://github.com/knpkv/npm/pull/44) [`e9c349f`](https://github.com/knpkv/npm/commit/e9c349fac3d2214a94aedaa3aaac40d0ea23d081) Thanks @konopkov! - Add code sandbox feature with Docker-based environments, plugin system, and web UI

### Patch Changes

- Updated dependencies [[`e9c349f`](https://github.com/knpkv/npm/commit/e9c349fac3d2214a94aedaa3aaac40d0ea23d081)]:
  - @knpkv/codecommit-core@0.5.0

## 0.4.0

### Minor Changes

- [#41](https://github.com/knpkv/npm/pull/41) [`c94efb9`](https://github.com/knpkv/npm/commit/c94efb90455b6e0049f80bd0d43b2bfc4f61de7b) Thanks @konopkov! - Add local SQLite cache layer with persistent notifications, PR subscriptions, per-PR refresh, and enriched notification messages

### Patch Changes

- Updated dependencies [[`c94efb9`](https://github.com/knpkv/npm/commit/c94efb90455b6e0049f80bd0d43b2bfc4f61de7b)]:
  - @knpkv/codecommit-core@0.4.0

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

### Patch Changes

- Updated dependencies [[`70bc0e8`](https://github.com/knpkv/npm/commit/70bc0e8deda4e2bc97c6eb7afcabb7274608c629)]:
  - @knpkv/codecommit-core@0.3.0

## 0.2.0

### Minor Changes

- [`f3cd927`](https://github.com/knpkv/npm/commit/f3cd9274fb70f9428e2bc27d4c3d601a985a7adf) Thanks @konopkov! - feat: PR health score with comments and hot filter

### Patch Changes

- Updated dependencies [[`f3cd927`](https://github.com/knpkv/npm/commit/f3cd9274fb70f9428e2bc27d4c3d601a985a7adf)]:
  - @knpkv/codecommit-core@0.2.0

## 0.1.2

### Patch Changes

- [#35](https://github.com/knpkv/npm/pull/35) [`c0ba0c5`](https://github.com/knpkv/npm/commit/c0ba0c51c49cc30ab6a5a9d7633c0f5cfa036d9c) Thanks @konopkov! - fix: use workspace:^ for proper version resolution on publish

- Updated dependencies [[`c0ba0c5`](https://github.com/knpkv/npm/commit/c0ba0c51c49cc30ab6a5a9d7633c0f5cfa036d9c)]:
  - @knpkv/codecommit-core@0.1.2

## 0.1.1

### Patch Changes

- [#33](https://github.com/knpkv/npm/pull/33) [`5da23ba`](https://github.com/knpkv/npm/commit/5da23ba57f670de8c0c5aa308992450072be3ede) Thanks @konopkov! - fix: packaging fixes for npm publish
  - Set publishConfig.access to public
  - Add publishConfig.exports to codecommit-core
  - Add prepack scripts
  - Pin distilled-aws to 0.0.21

- Updated dependencies [[`5da23ba`](https://github.com/knpkv/npm/commit/5da23ba57f670de8c0c5aa308992450072be3ede)]:
  - @knpkv/codecommit-core@0.1.1

## 0.1.0

### Minor Changes

- [#27](https://github.com/knpkv/npm/pull/27) [`d27338d`](https://github.com/knpkv/npm/commit/d27338d54098a07edc7eb17b33f1fe77cfa2cd35) Thanks @konopkov! - feat: add codecommit packages for browsing AWS CodeCommit PRs
  - `codecommit-core`: domain model, PRService, ConfigService, AwsClient, branded types
  - `codecommit`: TUI with OpenTUI components, atom state, 30+ themes, tests
  - `codecommit-web`: web UI with Effect HttpApi, SSE, shadcn/Tailwind

### Patch Changes

- Updated dependencies [[`d27338d`](https://github.com/knpkv/npm/commit/d27338d54098a07edc7eb17b33f1fe77cfa2cd35)]:
  - @knpkv/codecommit-core@0.1.0
