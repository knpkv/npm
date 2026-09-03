# @knpkv/codecommit

## 0.12.0

### Minor Changes

- [#410](https://github.com/knpkv/npm/pull/410) [`161566b`](https://github.com/knpkv/npm/commit/161566bccefc349e99d39734c910605d85cf1866) Thanks [@konopkov](https://github.com/konopkov)! - Add Claude-native Relay review profiles and persist Relay settings immediately after save.

### Patch Changes

- Updated dependencies [[`161566b`](https://github.com/knpkv/npm/commit/161566bccefc349e99d39734c910605d85cf1866), [`e4fb297`](https://github.com/knpkv/npm/commit/e4fb2975fa5a23f679fda0e0921d6837c4b684aa), [`316eff1`](https://github.com/knpkv/npm/commit/316eff159bc44fa46d5d1ec68d4515990fb3d9a1)]:
  - @knpkv/codecommit-core@0.16.0
  - @knpkv/codecommit-web@0.16.0

## 0.11.1

### Patch Changes

- Updated dependencies [[`dc18f2c`](https://github.com/knpkv/npm/commit/dc18f2c7149cdf6a0b4eee1461d41170311dd5fc), [`75ece0a`](https://github.com/knpkv/npm/commit/75ece0ab3d666488bc32820aeef56adb0873cead)]:
  - @knpkv/codecommit-core@0.15.0
  - @knpkv/codecommit-web@0.15.0

## 0.11.0

### Minor Changes

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

- [#387](https://github.com/knpkv/npm/pull/387) [`4ad196f`](https://github.com/knpkv/npm/commit/4ad196f7fe5e6ed68b6646681123bc1f603979fa) Thanks [@konopkov](https://github.com/konopkov)! - Make Relay profiles own the review kind, skills, provider harness, and model across settings, execution, and restored sessions.

### Patch Changes

- Updated dependencies [[`4ad196f`](https://github.com/knpkv/npm/commit/4ad196f7fe5e6ed68b6646681123bc1f603979fa), [`6d42c7c`](https://github.com/knpkv/npm/commit/6d42c7ce69e8b9116df409ec79579bf45d380fad), [`8caea60`](https://github.com/knpkv/npm/commit/8caea601c147b8a1dd0ea9f20155f4e76ff6351e), [`7c982c9`](https://github.com/knpkv/npm/commit/7c982c9f0ec56a65adff1275182a30f43f0eb0ee), [`94ee004`](https://github.com/knpkv/npm/commit/94ee00487f0595cdc16fd8f1332689eb39ecfaf2), [`4ad196f`](https://github.com/knpkv/npm/commit/4ad196f7fe5e6ed68b6646681123bc1f603979fa)]:
  - @knpkv/ai-codex@0.4.0
  - @knpkv/codecommit-core@0.14.0
  - @knpkv/codecommit-web@0.14.0

## 0.10.0

### Minor Changes

- [#373](https://github.com/knpkv/npm/pull/373) [`9364cc5`](https://github.com/knpkv/npm/commit/9364cc5834eda7f57c7724b9cd7052b6c9f6f15d) Thanks [@konopkov](https://github.com/konopkov)! - Add streamed web Relay progress, configurable prompt-only review profiles and environment skills, reload-safe finding conversations and exact-head re-review, independently scrolling findings and replies, a collapsible changed-file hierarchy, local acknowledge/reject decisions, bidirectional comment-to-diff navigation, and permission-gated publication of accepted findings as native line comments or file-anchored PR comments.

### Patch Changes

- [#361](https://github.com/knpkv/npm/pull/361) [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade the workspace to Effect 4.0.0-rc.109, pin the vendored Effect reference to that exact upstream release, guard source/package alignment, and bound Control Center test concurrency for reliable CI execution.
- Updated dependencies [[`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2), [`9364cc5`](https://github.com/knpkv/npm/commit/9364cc5834eda7f57c7724b9cd7052b6c9f6f15d)]:
  - @knpkv/agent-skills@0.3.1
  - @knpkv/ai-codex@0.3.1
  - @knpkv/codecommit-core@0.13.0
  - @knpkv/codecommit-web@0.13.0

## 0.9.0

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

- [#363](https://github.com/knpkv/npm/pull/363) [`316c383`](https://github.com/knpkv/npm/commit/316c3832c64ce159b7b18d9be3d58bf355c20b8a) Thanks [@konopkov](https://github.com/konopkov)! - Require Node.js 26 or newer and align the reproducible development, CI, release,
  benchmark, and package-validation toolchains with Node.js 26.

  Keep the CodeCommit CLI on the current Bun runtime, document that executable
  prerequisite, and require its Bun-hosted process boundaries in CI.

- Updated dependencies [[`b0ceb6e`](https://github.com/knpkv/npm/commit/b0ceb6ec9957c1be3de8700168e7767a3eb68203), [`d73b113`](https://github.com/knpkv/npm/commit/d73b113d6d49a9ffa9e553312c98d00e793af325), [`756ba26`](https://github.com/knpkv/npm/commit/756ba26b10c663b6768016c92ef7eab3da4f99d4), [`b08ca20`](https://github.com/knpkv/npm/commit/b08ca2004b3efcd72a695b44c72b56dae20afdfd), [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2), [`316c383`](https://github.com/knpkv/npm/commit/316c3832c64ce159b7b18d9be3d58bf355c20b8a), [`b08ca20`](https://github.com/knpkv/npm/commit/b08ca2004b3efcd72a695b44c72b56dae20afdfd), [`4dd1a0a`](https://github.com/knpkv/npm/commit/4dd1a0a5151b26fd13de29b8297c788bb0302e94), [`77e3257`](https://github.com/knpkv/npm/commit/77e3257743aacfaf9e11e016a60206f416c5fe79), [`27d2ca1`](https://github.com/knpkv/npm/commit/27d2ca18b0c0b0f8a252d461c0aaf10eb92e9ffc)]:
  - @knpkv/codecommit-web@0.12.0
  - @knpkv/codecommit-core@0.12.0
  - @knpkv/agent-skills@0.3.0
  - @knpkv/ai-codex@0.3.0

## 0.8.0

### Minor Changes

- [#351](https://github.com/knpkv/npm/pull/351) [`6d7947d`](https://github.com/knpkv/npm/commit/6d7947dd0ee0a84283d5f6162c5cfee62e6b775a) Thanks [@konopkov](https://github.com/konopkov)! - Open CodeCommit pull requests with API-backed diffs before any source checkout, switch to local Git only after an explicit worktree action, and prompt to update retained worktrees when the provider revision changes.

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

- [#352](https://github.com/knpkv/npm/pull/352) [`b9d4a96`](https://github.com/knpkv/npm/commit/b9d4a96855ab42d2c26ad514669d82e36f0e3b0a) Thanks [@konopkov](https://github.com/konopkov)! - Keep local pull-request worktrees scoped to the exact repository account and clear stale drift when the provider returns to the checked-out revision.

- [#345](https://github.com/knpkv/npm/pull/345) [`471974f`](https://github.com/knpkv/npm/commit/471974f89a86d01594cb9ac08d784ec1f4770541) Thanks [@konopkov](https://github.com/konopkov)! - Move both terminal applications from an OpenTUI preview build to the stable 0.5.1 release. Replace CodeCommit's flat pull-request detail page with an exact-head review workspace: complete changed-file inventory, lazy native diff previews, human decision state, preflighted prompt-only local Codex review actions, and deterministic detached worktree checkout. Add a prompt-only Codex transport mode for reviewing supplied untrusted text without host-capable tools or inherited instructions. Clear inherited repository-local Git variables, suppress configured hooks, and disable interactive authentication before Relay and worktree Git commands.

### Patch Changes

- Updated dependencies [[`b4e09d6`](https://github.com/knpkv/npm/commit/b4e09d659a56b8213767ffda06dffb75fa74d489), [`471974f`](https://github.com/knpkv/npm/commit/471974f89a86d01594cb9ac08d784ec1f4770541)]:
  - @knpkv/ai-codex@0.2.0
  - @knpkv/codecommit-core@0.11.0
  - @knpkv/codecommit-web@0.11.4

## 0.7.3

### Patch Changes

- [#343](https://github.com/knpkv/npm/pull/343) [`4def7db`](https://github.com/knpkv/npm/commit/4def7db2f400cf68218262994d67ed90a7154bf1) Thanks [@konopkov](https://github.com/konopkov)! - Align runtime ownership, cancellation, caching, time, failure handling, polling,
  decoding, and executable entrypoints with Effect v4 idioms. Expose clock-injected
  Atlassian token construction and expiry helpers, and enable workspace-wide
  Effect diagnostics and prevention checks.
- Updated dependencies [[`f35e10d`](https://github.com/knpkv/npm/commit/f35e10dcf2dc7ac50538621904f7acd4420956e6), [`4def7db`](https://github.com/knpkv/npm/commit/4def7db2f400cf68218262994d67ed90a7154bf1)]:
  - @knpkv/codecommit-core@0.10.1
  - @knpkv/codecommit-web@0.11.3

## 0.7.2

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
  - @knpkv/codecommit-web@0.11.2

## 0.7.1

### Patch Changes

- [#125](https://github.com/knpkv/npm/pull/125) [`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade the workspace to Effect 4.0.0-beta.98 and current compatible dependencies. Replace ad hoc object guards with Effect Predicate helpers and migrate retry schedules to the current Schedule API.

- Updated dependencies [[`41565ba`](https://github.com/knpkv/npm/commit/41565ba9d1adf50abf36620dec1e9dee516f5133), [`459962f`](https://github.com/knpkv/npm/commit/459962f2d71a8d36ffdb5fd4cf1b70d413973445), [`f2c7c3f`](https://github.com/knpkv/npm/commit/f2c7c3fb1acff1907c7c9fbeb613775eab5c5c2b), [`e1d121d`](https://github.com/knpkv/npm/commit/e1d121d5782f756d0a8f271d59a39a3b98f42c38), [`0df499b`](https://github.com/knpkv/npm/commit/0df499bb3241a4efa9a4179f649233943310f47d), [`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43), [`fe27e3c`](https://github.com/knpkv/npm/commit/fe27e3c74630d52b25d840e10fe8ea58b38b6b65)]:
  - @knpkv/codecommit-core@0.9.0
  - @knpkv/agent-skills@0.2.3
  - @knpkv/codecommit-web@0.11.1

## 0.7.0

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

- [#87](https://github.com/knpkv/npm/pull/87) [`67978dc`](https://github.com/knpkv/npm/commit/67978dcd59eaae0f9eced9c5072c6486428806c8) Thanks [@konopkov](https://github.com/konopkov)! - Avoid the Effect/Undici teardown crash in the CodeCommit CLI by using the
  fetch-backed HTTP client layer.

- [#88](https://github.com/knpkv/npm/pull/88) [`a245d53`](https://github.com/knpkv/npm/commit/a245d534f3946c0b3d8b0a0380dbd702d9f2982d) Thanks [@konopkov](https://github.com/konopkov)! - Fix the TUIs hanging after quit. On a clean in-app quit the main fiber exits with code 0, and because OpenTUI keeps stdin in raw mode (so Ctrl-C arrives as a keypress, not a SIGINT) `runMain`'s default teardown never called `process.exit`. The atom runtime kept the event loop alive (SQLite repos, HTTP client, EventsHub PubSub), so the process hung after the UI had already torn down. Both bins now pass a teardown that always terminates the host process.

- Updated dependencies [[`c697d3c`](https://github.com/knpkv/npm/commit/c697d3c4ab779f14f017d3ec8fc8d1bffa1493b5), [`19c1538`](https://github.com/knpkv/npm/commit/19c153835bc198b9e407a013c16775c3fb7eb357), [`e3c3805`](https://github.com/knpkv/npm/commit/e3c3805ee527a6edb69ed91977c95c586b563ff9)]:
  - @knpkv/agent-skills@0.2.0
  - @knpkv/codecommit-core@0.8.0
  - @knpkv/codecommit-web@0.11.0

## 0.6.0

### Minor Changes

- [#69](https://github.com/knpkv/npm/pull/69) [`ebe2800`](https://github.com/knpkv/npm/commit/ebe280079863e7236de20bf06c0db6446215dab1) Thanks @konopkov! - Add `--filter` preset option to `codecommit pr list` that fans out across all
  enabled accounts in `~/.codecommit/config.json`. Presets: `mine` (PRs you
  authored), `needs-my-review` (PRs awaiting your approval), `stale` (no activity
  for >7d), `conflicting` (merge conflicts). Caller identity is resolved per
  profile via `getCallerIdentity`. `--profile`/`--region` are ignored when
  `--filter` is set; `--repo`/`--author`/`--json` still compose normally.

## 0.5.5

### Patch Changes

- Updated dependencies [[`0f58736`](https://github.com/knpkv/npm/commit/0f587363a1a7acb203f41a24b0cfe4861a2998c0)]:
  - @knpkv/codecommit-web@0.10.0

## 0.5.4

### Patch Changes

- Updated dependencies [[`3ce2182`](https://github.com/knpkv/npm/commit/3ce21821504c75b294555163a660bf02010a4bde)]:
  - @knpkv/codecommit-core@0.7.0
  - @knpkv/codecommit-web@0.9.0

## 0.5.3

### Patch Changes

- Updated dependencies [[`ed64b64`](https://github.com/knpkv/npm/commit/ed64b64ae5e8e27a6629a72807e35299826a1372)]:
  - @knpkv/codecommit-core@0.6.0
  - @knpkv/codecommit-web@0.8.0

## 0.5.2

### Patch Changes

- Updated dependencies [[`ada91ba`](https://github.com/knpkv/npm/commit/ada91bab4fe275cefe6aac1c061a0f7f16b1e000)]:
  - @knpkv/codecommit-web@0.7.0

## 0.5.1

### Patch Changes

- Updated dependencies [[`3932903`](https://github.com/knpkv/npm/commit/3932903aefc932fc74fcd599e7cd7850a0a3f57c)]:
  - @knpkv/codecommit-web@0.6.0
  - @knpkv/codecommit-core@0.5.1

## 0.5.0

### Minor Changes

- [#44](https://github.com/knpkv/npm/pull/44) [`e9c349f`](https://github.com/knpkv/npm/commit/e9c349fac3d2214a94aedaa3aaac40d0ea23d081) Thanks @konopkov! - Add code sandbox feature with Docker-based environments, plugin system, and web UI

### Patch Changes

- Updated dependencies [[`e9c349f`](https://github.com/knpkv/npm/commit/e9c349fac3d2214a94aedaa3aaac40d0ea23d081)]:
  - @knpkv/codecommit-core@0.5.0
  - @knpkv/codecommit-web@0.5.0

## 0.4.0

### Minor Changes

- [#41](https://github.com/knpkv/npm/pull/41) [`c94efb9`](https://github.com/knpkv/npm/commit/c94efb90455b6e0049f80bd0d43b2bfc4f61de7b) Thanks @konopkov! - Add local SQLite cache layer with persistent notifications, PR subscriptions, per-PR refresh, and enriched notification messages

### Patch Changes

- Updated dependencies [[`c94efb9`](https://github.com/knpkv/npm/commit/c94efb90455b6e0049f80bd0d43b2bfc4f61de7b)]:
  - @knpkv/codecommit-core@0.4.0
  - @knpkv/codecommit-web@0.4.0

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
  - @knpkv/codecommit-web@0.3.0

## 0.2.0

### Minor Changes

- [`f3cd927`](https://github.com/knpkv/npm/commit/f3cd9274fb70f9428e2bc27d4c3d601a985a7adf) Thanks @konopkov! - feat: PR health score with comments and hot filter

### Patch Changes

- Updated dependencies [[`f3cd927`](https://github.com/knpkv/npm/commit/f3cd9274fb70f9428e2bc27d4c3d601a985a7adf)]:
  - @knpkv/codecommit-core@0.2.0
  - @knpkv/codecommit-web@0.2.0

## 0.1.2

### Patch Changes

- [#35](https://github.com/knpkv/npm/pull/35) [`c0ba0c5`](https://github.com/knpkv/npm/commit/c0ba0c51c49cc30ab6a5a9d7633c0f5cfa036d9c) Thanks @konopkov! - fix: use workspace:^ for proper version resolution on publish

- Updated dependencies [[`c0ba0c5`](https://github.com/knpkv/npm/commit/c0ba0c51c49cc30ab6a5a9d7633c0f5cfa036d9c)]:
  - @knpkv/codecommit-core@0.1.2
  - @knpkv/codecommit-web@0.1.2

## 0.1.1

### Patch Changes

- [#33](https://github.com/knpkv/npm/pull/33) [`5da23ba`](https://github.com/knpkv/npm/commit/5da23ba57f670de8c0c5aa308992450072be3ede) Thanks @konopkov! - fix: packaging fixes for npm publish
  - Set publishConfig.access to public
  - Add publishConfig.exports to codecommit-core
  - Add prepack scripts
  - Pin distilled-aws to 0.0.21

- Updated dependencies [[`5da23ba`](https://github.com/knpkv/npm/commit/5da23ba57f670de8c0c5aa308992450072be3ede)]:
  - @knpkv/codecommit-core@0.1.1
  - @knpkv/codecommit-web@0.1.1

## 0.1.0

### Minor Changes

- [#27](https://github.com/knpkv/npm/pull/27) [`d27338d`](https://github.com/knpkv/npm/commit/d27338d54098a07edc7eb17b33f1fe77cfa2cd35) Thanks @konopkov! - feat: add codecommit packages for browsing AWS CodeCommit PRs
  - `codecommit-core`: domain model, PRService, ConfigService, AwsClient, branded types
  - `codecommit`: TUI with OpenTUI components, atom state, 30+ themes, tests
  - `codecommit-web`: web UI with Effect HttpApi, SSE, shadcn/Tailwind

### Patch Changes

- Updated dependencies [[`d27338d`](https://github.com/knpkv/npm/commit/d27338d54098a07edc7eb17b33f1fe77cfa2cd35)]:
  - @knpkv/codecommit-core@0.1.0
  - @knpkv/codecommit-web@0.1.0
