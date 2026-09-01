# @knpkv/codecommit-core

## 0.15.0

### Minor Changes

- [#394](https://github.com/knpkv/npm/pull/394) [`dc18f2c`](https://github.com/knpkv/npm/commit/dc18f2c7149cdf6a0b4eee1461d41170311dd5fc) Thanks [@konopkov](https://github.com/konopkov)! - Preserve exact CodeCommit pull-request coordinates across cache, sandbox,
  notification, and review routes.

### Patch Changes

- [#390](https://github.com/knpkv/npm/pull/390) [`75ece0a`](https://github.com/knpkv/npm/commit/75ece0ab3d666488bc32820aeef56adb0873cead) Thanks [@konopkov](https://github.com/konopkov)! - Add one shared, collapsed Relay dock with durable pull-request threads, visible
  model and profile selection, and host-to-pull-request continuation.

## 0.14.0

### Minor Changes

- [#384](https://github.com/knpkv/npm/pull/384) [`6d42c7c`](https://github.com/knpkv/npm/commit/6d42c7ce69e8b9116df409ec79579bf45d380fad) Thanks [@konopkov](https://github.com/konopkov)! - Add a reusable child environment that prevents Git hooks from redirecting explicit fixture repositories.

- [#380](https://github.com/knpkv/npm/pull/380) [`8caea60`](https://github.com/knpkv/npm/commit/8caea601c147b8a1dd0ea9f20155f4e76ff6351e) Thanks [@konopkov](https://github.com/konopkov)! - Open shared CodeCommit pull-request links as durable, release-independent Control Center reviews, show stale-head and per-run usage state, explain validated changes as ordered cohorts and layers, and route both applications through a loopback-only deterministic CodeCommit mock for local review-cycle testing.

- [#383](https://github.com/knpkv/npm/pull/383) [`7c982c9`](https://github.com/knpkv/npm/commit/7c982c9f0ec56a65adff1275182a30f43f0eb0ee) Thanks [@konopkov](https://github.com/konopkov)! - Add `codecommit pr open`, which resolves the open PR for the branch checked out
  in a working directory and opens its console page.

  The remote names the repository and usually the region. An embedded
  git-remote-codecommit profile narrows the scan; otherwise ambiguous matches
  across accounts and incomplete scans are rejected. Regionless helper remotes
  must resolve to one configured region. Exact-repository fetching avoids losing
  the result to an unrelated repository failure, and repository absence is
  treated as a conclusive empty result. `--json` and `--url` print the
  resolution instead of opening it.

  Adds `collectOpen` to the exported `FilterServiceContract` — the preset-free
  counterpart to `collect`, narrowed only by repo/author — and exports
  `codecommitPullRequestConsoleUrl`, a partition-aware PR console link builder.
  `AwsClient.getPullRequests` now accepts an optional exact repository name.

- [#382](https://github.com/knpkv/npm/pull/382) [`94ee004`](https://github.com/knpkv/npm/commit/94ee00487f0595cdc16fd8f1332689eb39ecfaf2) Thanks [@konopkov](https://github.com/konopkov)! - Run release-independent CodeCommit reviews through authenticated native Codex sandboxes, resolve AWS SSO profiles safely, preserve redacted review failure stages and causes, and make review setup, settings, service health, and narrow-screen navigation clearer.
  Review activity now scrolls independently, follows new output without stealing a reader's position, and keeps a multiline draft composer available while a run is active.

- [#387](https://github.com/knpkv/npm/pull/387) [`4ad196f`](https://github.com/knpkv/npm/commit/4ad196f7fe5e6ed68b6646681123bc1f603979fa) Thanks [@konopkov](https://github.com/konopkov)! - Make Relay profiles own the review kind, skills, provider harness, and model across settings, execution, and restored sessions.

## 0.13.0

### Minor Changes

- [#373](https://github.com/knpkv/npm/pull/373) [`9364cc5`](https://github.com/knpkv/npm/commit/9364cc5834eda7f57c7724b9cd7052b6c9f6f15d) Thanks [@konopkov](https://github.com/konopkov)! - Add streamed web Relay progress, configurable prompt-only review profiles and environment skills, reload-safe finding conversations and exact-head re-review, independently scrolling findings and replies, a collapsible changed-file hierarchy, local acknowledge/reject decisions, bidirectional comment-to-diff navigation, and permission-gated publication of accepted findings as native line comments or file-anchored PR comments.

### Patch Changes

- [#361](https://github.com/knpkv/npm/pull/361) [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade the workspace to Effect 4.0.0-rc.109, pin the vendored Effect reference to that exact upstream release, guard source/package alignment, and bound Control Center test concurrency for reliable CI execution.

## 0.12.0

### Minor Changes

- [#367](https://github.com/knpkv/npm/pull/367) [`b0ceb6e`](https://github.com/knpkv/npm/commit/b0ceb6ec9957c1be3de8700168e7767a3eb68203) Thanks [@konopkov](https://github.com/konopkov)! - Add an exact-revision CodeCommit diff workbench backed by the diffs.com renderer, including bounded text rendering and file-mode changes, plus permission-gated ephemeral prompt-only Relay reviews with full, security, tests, and explanation focuses.

- [#353](https://github.com/knpkv/npm/pull/353) [`d73b113`](https://github.com/knpkv/npm/commit/d73b113d6d49a9ffa9e553312c98d00e793af325) Thanks [@konopkov](https://github.com/konopkov)! - Add exact-head CodeCommit pull-request merging from the TUI with selectable squash, fast-forward, and three-way strategies.

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

## 0.11.0

### Minor Changes

- [#350](https://github.com/knpkv/npm/pull/350) [`b4e09d6`](https://github.com/knpkv/npm/commit/b4e09d659a56b8213767ffda06dffb75fa74d489) Thanks [@konopkov](https://github.com/konopkov)! - Fix real-account CodeCommit TUI authentication actions, terminal text input,
  quick-filter commands, settings key ownership, branch pagination, and Granted
  console destinations, and support the Codex CLI 0.147 feature inventory for
  prompt-only Relay runs. Align the TUI shell, pull-request list, exact-revision
  workspace, settings, and dialogs with the Control Center visual language. Add a
  hierarchical changed-file rail and human disposition of structured Relay
  findings, including revision-preflighted CodeCommit comment posting. Prepare an
  exact-head checkout when opening a PR, render diffs from immutable local Git
  objects, and cache successful previews across file navigation. Preserve complete
  bounded file-tree names at every hierarchy depth and make long rows horizontally
  inspectable. Render every fetched review thread with explicit general, file, or
  line coordinates and identify coordinates from older revisions instead of
  hiding their comments. Open the selected verified exact-head file in
  same-terminal Neovim or external VS Code, preserving a selected finding's line
  anchor when available. Render textual changes as a synchronized, line-numbered
  base/head split diff by default. Add a multi-select review-skill picker and
  snapshot the selected PR Review / PR Diff Review playbooks into each prompt-only
  Relay run. Present and post findings as evidence-led P1–P4 issue cards with
  separate Summary, Details, Recommendation, Verification, and Location fields.
  Route each finding to the PR description, PR comments, file-anchored PR comments,
  or exact line comments; add a wraparound finding deck, unresolved jump, publication
  target picker, and finding-specific follow-up conversations that reconcile the
  complete finding set and reopen affected local decisions. Verify an individual
  finding against CodeCommit's latest exact revision, report whether it was
  resolved, remains actionable, was superseded, or could not be established, and
  reconcile every dependent finding and human decision from the refreshed patch.
  Keep cached open pull requests when an account refresh fails, and publish newly
  fetched and enriched pull requests to the live TUI state before that same
  refresh completes. Preload a bounded prefix of immutable local file previews
  before exposing an exact-head workspace, then load larger-review overflow from
  the same local checkout, and make the second Ctrl+C consume the armed exit confirmation
  synchronously.
  Reject malformed or duplicate-id Relay output, isolate prior agent review text as
  untrusted prompt evidence, validate exact changed-side line anchors before
  posting, and keep edited or stale-posted findings attached to explicit human
  resolution and content-bound provider receipts. Preserve finding-post and
  conversation state across same-batch terminal input, and promote a successful
  manual exact-head checkout into local preview and editor readiness.
  Keep active provider-post receipts owned across workspace refreshes, base
  comment idempotency on the resolved repository account rather than a local AWS
  profile alias, and apply publication-target navigation synchronously.

## 0.10.1

### Patch Changes

- [#328](https://github.com/knpkv/npm/pull/328) [`f35e10d`](https://github.com/knpkv/npm/commit/f35e10dcf2dc7ac50538621904f7acd4420956e6) Thanks [@konopkov](https://github.com/konopkov)! - Extend human-confirmed CodeCommit review publication with exact comment updates and replies, marker-based reconciliation, and preview-bound operation targets.

- [#343](https://github.com/knpkv/npm/pull/343) [`4def7db`](https://github.com/knpkv/npm/commit/4def7db2f400cf68218262994d67ed90a7154bf1) Thanks [@konopkov](https://github.com/konopkov)! - Align runtime ownership, cancellation, caching, time, failure handling, polling,
  decoding, and executable entrypoints with Effect v4 idioms. Expose clock-injected
  Atlassian token construction and expiry helpers, and enable workspace-wide
  Effect diagnostics and prevention checks.

## 0.10.0

### Minor Changes

- [#262](https://github.com/knpkv/npm/pull/262) [`dd0163e`](https://github.com/knpkv/npm/commit/dd0163ec002ae8abbce0b19df61431b3a4701314) Thanks [@konopkov](https://github.com/konopkov)! - Add immutable CodeCommit pull-request review actions with governed proposals, durable provider receipts, and non-replaying reconciliation.

- [#290](https://github.com/knpkv/npm/pull/290) [`b97fd1b`](https://github.com/knpkv/npm/commit/b97fd1b2433bcaef600e5470e2ce92d7edc71f94) Thanks [@konopkov](https://github.com/konopkov)! - Add human-confirmed publication of agent review suggestions as exact-line CodeCommit comments, including AWS identity and immutable revision previews, editable content, durable governed-action receipts, retry-safe idempotency recovery, and the corresponding operator UI. Preserve inline review locations in the CodeCommit action contract and add a typed effect-qb lookup for governed action recovery.

### Patch Changes

- [#259](https://github.com/knpkv/npm/pull/259) [`7da266b`](https://github.com/knpkv/npm/commit/7da266bbb8cbf47f0f826274cc890384011e08e0) Thanks [@konopkov](https://github.com/konopkov)! - Make CodeCommit manual synchronization resilient to real provider responses.
  Pull-request decoding now normalizes untrimmed titles and tolerates omitted
  author identities instead of failing the whole stream, and schema-decode
  failures are surfaced in logs with the offending field. Reduce the
  GetPullRequest hydration fan-out to stay under CodeCommit's throttle ceiling,
  and honor a bounded provider Retry-After when retrying rate-limited syncs.
  Correct the manual-sync timestamp rendering and show an explicit in-progress
  state in the services UI.

- [#309](https://github.com/knpkv/npm/pull/309) [`f804a71`](https://github.com/knpkv/npm/commit/f804a7102bdd7bb8b9732e5e5d9cb9bf66e6c00f) Thanks [@konopkov](https://github.com/konopkov)! - Fix `NotFound: ChildProcess.spawn` when opening a PR in the AWS console or cloning into a review sandbox. `ChildProcess.make` replaces the child environment unless `extendEnv` is set, so passing only `GRANTED_ALIAS_CONFIGURED` or the `AWS_PROFILE` overrides dropped `PATH` and the `assume`, `git`, and `aws` executables could no longer be resolved.

  Inheriting the caller's environment also means inheriting its AWS credentials, which the credential chain resolves above profile configuration. Profile-scoped spawns now go through `ChildEnv.profileScopedEnv` so the requested profile and region stay authoritative instead of a sandbox clone silently authenticating as the host's identity.

  **Behaviour change.** These ambient variables are now removed from the child environment of the `assume` and sandbox-clone spawns:

  - static credentials — `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_SECURITY_TOKEN`, `AWS_CREDENTIAL_EXPIRATION`
  - web identity — `AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_SESSION_NAME`
  - region — `AWS_REGION`, `AWS_DEFAULT_REGION`

  If you relied on any of these to steer these commands, pass the value explicitly instead; the named profile now decides. `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` are deliberately preserved. `ChildEnv.ts` carries the authoritative list and the reasoning, including a documented Windows case-insensitivity limitation.

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
