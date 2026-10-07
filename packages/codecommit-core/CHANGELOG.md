# @knpkv/codecommit-core

## 0.22.0

### Minor Changes

- [#578](https://github.com/knpkv/npm/pull/578) [`0938903`](https://github.com/knpkv/npm/commit/0938903a17b6d2bdf13b96947471a1d49f10b42f) Thanks [@konopkov](https://github.com/konopkov)! - A first run of the CodeCommit web app now leads somewhere at every step.

  - The page shows whether its live stream is connecting, not signed in (the browser has no session: open the sign-in link `codecommit web` printed), failing (with the cause and "Retry now"), or live. Counts read as unknown, never 0, until the first update arrives. A lost stream no longer looks like an empty queue.
  - An empty queue says why: no AWS profiles yet (with "Set up accounts"), filters hiding cached pull requests, or nothing open.
  - Settings → Accounts with no profiles shows where profiles are read from, the `aws configure` commands that create one, and "Detect again", which reports what it found. It never edits AWS files.
  - Settings → Config says a missing config file means defaults are in use.
  - Error notifications name what failed, the provider's own error and the fix ("Couldn't list pull requests in dev (eu-central-1): ExpiredTokenException: … Sign in again in Settings → Accounts.") instead of "getPullRequests — AwsApiError".
  - `@knpkv/codecommit-core`: AWS profile detection follows `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` like the AWS CLI. New exports: `ConfigService.awsProfileSources`, `awsProfileSourcesIn`, `AwsProfileSources`, and `Errors.describeAwsClientError`.
  - A read the app hasn't been allowed yet asks in a bar at the top of the page instead of a blocking dialog; "Allow every read" grants every read operation in one saved step, and the queue says it is waiting for that answer. Writes still ask in a dialog, now with "Allow once" as the default. Saving that grant releases every read already waiting, not just the one shown. `@knpkv/codecommit-core`: `PermissionService.setCategory` sets a whole category in one atomic write and fails with `ConfigError` when it can't save; every permission change is now serialized, so a concurrent reset or change can't be overwritten. `PermissionGateLive.resolveCategory` answers every pending prompt of a category.
  - Settings → Accounts lists each profile as a switch named by the profile, and auto-detect is a checkbox. A settings or stats read that fails stays in its region with the reason (and Retry for stats) instead of replacing the page.
  - `codecommit web` prints the sign-in link on its own, saying it works once within 60 seconds.
  - Approval rules this page created can be removed; the pull request refreshes once the rule is gone, and a failed removal says why.
  - Switching an account on and leaving Settings straight away no longer loses the change: a pending save is sent when the page closes and runs to completion. The auto-detect checkbox keeps its choice. "Detect again" reports only after detection finished, and with auto-detect off it switches auto-detect on first. Counts read as unknown, not 0, while the first sync runs or waits for permission.

### Patch Changes

- [#581](https://github.com/knpkv/npm/pull/581) [`c22e8ae`](https://github.com/knpkv/npm/commit/c22e8ae0c55a50e9c1edbd46a1cd18108f62e4fa) Thanks [@konopkov](https://github.com/konopkov)! - Mark existing silent fallbacks (failures turned into success without a log) with a follow-up lint suppression. No behaviour change.

## 0.21.0

### Minor Changes

- [#569](https://github.com/knpkv/npm/pull/569) [`5509cb8`](https://github.com/knpkv/npm/commit/5509cb87f90641d14211e2d993443e3cfcf40784) Thanks [@konopkov](https://github.com/konopkov)! - Approval and health now read honestly on real queues.

  - `approvalOf` gains `NotRequired`, labelled "No approval required" (`approvalNotRequiredLabel`): CodeCommit evaluates a pull request with no approval rules as approved, though nobody signed off. "Approved" now appears only when rules exist and are satisfied. The CLI flags, TUI badge, web row, detail page and health score all show it. Status filters and counts treat it as neither approved nor pending.
  - No "Approval granted" or "revoked" notification is sent for a pull request without rules. An identical pull-request notification that is still unread is not added again, so a restart no longer re-announces it.
  - The cache records whether a pull request's approval baseline is known (migration 0024). A sign-off or withdrawal made while approval evaluation was failing is announced once evaluation recovers. A pull request first seen while evaluation fails holds only a placeholder, so its recovery is not announced.
  - The health score uses a saturating curve: a base of 8, minus up to 6 for idleness and up to 2 for age, plus up to 1.5 for comments (3 counted), 2 for an approval and 1 for "No approval required". Long-idle pull requests are now ranked instead of all reading 0.0, and fresh ones stay green. A pull request CodeCommit gave no dates for scores Unknown ("Health —") and sorts last; comments that haven't loaded make the score a lower bound.

- [#570](https://github.com/knpkv/npm/pull/570) [`c45b069`](https://github.com/knpkv/npm/commit/c45b069af37c78464332907fcb5cbe5903abf8a9) Thanks [@konopkov](https://github.com/konopkov)! - Executables linked from the repository (`pnpm link --global`, or `node dist/...`) run under plain Node: workspace packages resolve to their build output instead of TypeScript sources. Published `@knpkv/codecommit-core` now serves its `Domain.js`, `CacheService.js` and `SandboxService.js` subpaths; the last two resolved to files that do not exist before.

### Patch Changes

- [#574](https://github.com/knpkv/npm/pull/574) [`0a0182c`](https://github.com/knpkv/npm/commit/0a0182c18f237ab420d17d0339f0969d9356c63a) Thanks [@konopkov](https://github.com/konopkov)! - A failed comment fetch no longer reads as "no comments". The bulk and the single refresh write nothing: the comment count stays as it was (not loaded until a fetch succeeds), the cached comments are kept, and nothing is announced. Before, a failure stored 0 comments, and the single refresh also replaced the comment cache with an empty set, so the next successful fetch re-announced every existing comment.

- [#568](https://github.com/knpkv/npm/pull/568) [`442b11d`](https://github.com/knpkv/npm/commit/442b11db369a5af5e85d4d91d00c334d46f8103d) Thanks [@konopkov](https://github.com/konopkov)! - The test suites of codecommit-core and codecommit-web are now typechecked as part of `check`, and both packages leave the test-typecheck allowlist.

## 0.20.0

### Minor Changes

- [#525](https://github.com/knpkv/npm/pull/525) [`fd9d510`](https://github.com/knpkv/npm/commit/fd9d5103e3558561274b16c258023bee73b4b233) Thanks [@konopkov](https://github.com/konopkov)! - A pull request whose approval rules fail to evaluate is now listed with its approval unknown, instead of being dropped (never cached before) or shown with a stale cached approval.

  - `Domain` adds `ApprovalUnknownReason` (`NotPermitted`, `Throttled`, `ProviderFailed`), `PullRequest.approvalUnknown`, `approvalOf(pr)` (Approved, Pending or Unknown; Unknown wins), and the shared copy `approvalUnknownLabel` and `approvalUnknownReasonText`.
  - The cache persists the reason and keeps the last known approval and rules until an evaluation succeeds. Health stats no longer count an unknown approval as approved.
  - `AwsClient.getPullRequestRefresh` and `PullRequestRefreshItem` are removed: `getPullRequests` lists every pull request, with `approvalUnknown` set where evaluation failed. A single-PR refresh now also writes the evaluated approval.
  - The CLI list, TUI badges and health score show "Approval unknown"; an unknown approval is neither approved nor pending. The TUI status filter gains `unknown`.
  - codecommit-web's event stream and cached-row API carry the field. The web queue, workbench and detail page show "Approval unknown", and the reason on the detail page; an unknown approval is never shown or counted as approved, pending or ready. The status filter gains `unknown`, and "All open" includes those pull requests.
  - An expired or rejected session found while evaluating approval rules fails the read instead of reading as an unknown approval, so the refresh marks the account signed out. A `GetPullRequest` answer without a pull request fails as `MissingPullRequestResponse`.
  - No approval notification is sent when evaluation recovers from unknown: a pull request first seen while evaluation fails has no real last known value.
  - Every write to a cached pull-request row goes through `PullRequestRepo/rowWrites`, under three rules that keep an older read from overwriting a newer one:
    1. **Provider reads write whole column groups.** `upsert` (a listing) and the new `writeRead` (a re-read) take a complete `RowGroup` and `ApprovalGroup`, each written unless that group's version is newer. A version is the provider's last activity plus an observation number, which `PullRequestRepo.observe()` takes from the database before each read; compared in that order, it orders two reads of the same revision.
    2. **Recomputed values never move a version.** The new `writeDerived` (diff stats, comment count, health score, commenters) applies only while the row still holds both versions it was read at. The comment cache and its notifications follow only when it applied.
    3. **A tombstone keeps the later of both versions.** Only a provider "pull request does not exist" deletes a row, ordered by its observation, and the tombstone (migration 0023) stops a read that began earlier from bringing it back. Other read failures keep the row.

    `upsert` reports which groups it wrote (`GroupsWritten`), and notifications, unknown-approval reporting and auto-subscription follow only those. `recordApprovalEvaluation`, `updateStatusAndClosedAt`, `updateDiffStats`, `updateCommentCount` and `updateHealthScore` are removed. `deleteOne` takes the not-found read's observation. `AwsClient`'s `PullRequestDetail` gains `isMergeable`, so a re-read carries a whole row. The ast-grep rules `no-direct-pull-request-row-write` and `no-pull-request-free-form-row-write` keep other code from writing the table directly or in part.

- [#567](https://github.com/knpkv/npm/pull/567) [`3a59848`](https://github.com/knpkv/npm/commit/3a598483979960e71bfc880f182c73d499001091) Thanks [@konopkov](https://github.com/konopkov)! - A subscribed pull request's notifications describe the transition from the row the refresh actually replaced. `PullRequestRepo.upsert` and `upsertRead` read the row in the same transaction as the write and return it as `replaced` (`UpsertResult`). Before, the bulk and single refresh diffed a snapshot read earlier, so a write landing in between could hide a revocation or announce a change that didn't happen.

- [#532](https://github.com/knpkv/npm/pull/532) [`8f64bdf`](https://github.com/knpkv/npm/commit/8f64bdfee2ab758c53d0555850be42cfe9f3626e) Thanks [@konopkov](https://github.com/konopkov)! - Refreshing a pull request that has an approval rule works again, and the rule shows its approvers.

  - The cache's upsert input required `ApprovalRule` class instances, but the single-PR refresh passes the provider's rules as plain objects, so every refresh of such a PR failed (HTTP 500 in codecommit-web). `UpsertInput.approvalRules` now accepts the rule's plain shape.
  - Rule content whose `ApprovalPoolMembers` is a single string, such as `"*"`, is read as a one-member pool instead of failing to parse and showing no approvers. A rule that can't be parsed now logs the schema error with its path.
  - codecommit-web logs the cause of a failed refresh, and the PR page shares one in-flight refresh per pull request, so overlapping triggers no longer cancel each other.

### Patch Changes

- [#566](https://github.com/knpkv/npm/pull/566) [`286f23e`](https://github.com/knpkv/npm/commit/286f23ece7fc85b9a7a754b7b5f96b5e65868244) Thanks [@konopkov](https://github.com/konopkov)! - `PullRequestRepo.observe()` fails with a `CacheError` (cause `ObservationSequenceMissing`) when the observation sequence row is missing, instead of returning 0 for every read. That fallback would have silently stopped ordering reads of the same revision. Callers already skip a read whose observation fails.

## 0.19.0

### Minor Changes

- [#550](https://github.com/knpkv/npm/pull/550) [`44b633d`](https://github.com/knpkv/npm/commit/44b633d87c8b98ddb3fd03225124fa996e563473) Thanks [@konopkov](https://github.com/konopkov)! - `@knpkv/codecommit-core/AwsCredentialErrors.js` exports the credential-failure classifier that CodeCommit refresh already used. Control Center's CodeCommit and CodePipeline plugins and AWS discovery now use it too, so every adapter treats the same expired, unsigned or rejected sessions as a sign-in problem, including unknown provider errors carrying such a wire tag.

- [#531](https://github.com/knpkv/npm/pull/531) [`c01672d`](https://github.com/knpkv/npm/commit/c01672d8d55cd93580c06958e8cc202f5cde90c6) Thanks [@konopkov](https://github.com/konopkov)! - AWS adapters resolve local profiles SSO-first, so old keys in `~/.aws/credentials` no longer shadow `aws sso login`. `@knpkv/codecommit-core/AwsProfileCredentials.js` exports the shared resolver. Control Center's CodePipeline adapter uses the shared resolver; AWS discovery reports sign-in failures as `authentication`, and the setup form asks users to check their profile's credentials or sign-in session instead of showing "unavailable (unavailable)". Failed connection tests and discovery failures are logged with their failure tag and available diagnostic code.

- [#522](https://github.com/knpkv/npm/pull/522) [`da4b5eb`](https://github.com/knpkv/npm/commit/da4b5eb15e627c0dae13aa92a3ec0c848ab6225b) Thanks [@konopkov](https://github.com/konopkov)! - `AppState.callerIdentities` records who the caller is in every enabled account, keyed by AWS profile. Before, only `currentUser` existed, taken from the first enabled account alone. Each entry is `Resolved` (`accountId`, `arn`, `username`) or `Unresolved` with a typed `reason`: `CredentialsUnavailable`, `StsRejected` or `Throttled` from the identity lookup's error type, `RefreshAuthFailed` when a pull-request refresh hits an authentication error, or `SignedOut` after `aws sso logout`. `@knpkv/codecommit-core/Domain` exports the `CallerIdentityState`, `CallerIdentityUnresolvedReason` and `CallerIdentities` schemas, and `AwsClient.CallerIdentity` gains `arn`. The codecommit-web event stream sends `callerIdentities`, so the browser can match wildcard approval pools against the caller's exact ARN in each account. Identity is one state machine, `@knpkv/codecommit-core/IdentityLifecycle`: a single `transition` over identity events is the only writer, so a refresh, login or logout that happens meanwhile makes older in-flight work a no-op. SSO login and logout refresh right away. `currentUser` is now derived from the first enabled account's identity only, so signing in to another account no longer replaces it. `signInState` and `signOutState` move from `Domain` to `IdentityLifecycle`. The event stream also sends `unevaluatedPullRequests`: the pull requests the last refresh kept from cache because their approval rules failed to evaluate. `@knpkv/codecommit-core/Domain` exports it as an `UnevaluatedPullRequest` schema. Signing out of AWS SSO in codecommit-web now asks first: `aws sso logout` ends every SSO session on the machine, including other tools' sessions, and the confirmation says so and offers switching one account off instead. All three sign-out controls go through it. Success and failure are both notified; a failure names the command and its exit code or timeout. A failed `aws sso login` no longer counts as signed in.

## 0.18.0

### Minor Changes

- [#496](https://github.com/knpkv/npm/pull/496) [`43ab828`](https://github.com/knpkv/npm/commit/43ab8288a02a03924c66b5488d20ac7576e348e1) Thanks [@konopkov](https://github.com/konopkov)! - A failed `EvaluatePullRequestApprovalRules` call no longer shows a pull request as "pending approval" with every rule unsatisfied.

  - `AwsClient.getPullRequestRefresh` streams each pull request as `Fetched` or `EvaluationFailed` with a typed `ApprovalEvaluationError`. The refresh keeps a failed pull request's cached row, carries on with the account's other pull requests, and records the failure in `AppState.unevaluatedPullRequests`. The account's refresh then counts as partial rather than successful, and a notification says how many pull requests couldn't be re-evaluated.
  - `getPullRequests` and the pull-request detail still fail with the typed error, because they can't report one pull request as unknown.
  - The codecommit README now lists `codecommit:EvaluatePullRequestApprovalRules` and `codecommit:GetPullRequestApprovalStates` among the required IAM actions.

## 0.17.1

### Patch Changes

- [#492](https://github.com/knpkv/npm/pull/492) [`139ec4f`](https://github.com/knpkv/npm/commit/139ec4f66f1b790cb1364d1171a49f48496a60b8) Thanks [@konopkov](https://github.com/konopkov)! - Pull request pages now show the review queue beside the pull request in windows 800px and wider: what needs your review, what waits on a role pool you may be in, your own pull requests with the reason each is stuck, and what you are watching. The open pull request is marked, and arrow keys move through the list. Phones and 768px tablets keep the pull request alone.

  Enter on a focused link or button on a pull request page now does only that, instead of also opening the AWS console.

  The review count on the Pull requests tab, the review reminder, the pull request list's "needs my review" filter and the queue now count the same pull requests. A rule with no approval pool asks everyone but the author for review, and a pull request waiting only on a wildcard role pool is listed apart, not counted.

  The live events stream no longer sends `pendingReviewCount`; the web client counts reviews itself. `AppState.pendingReviewCount` in codecommit-core is documented as unused by the web app.

## 0.17.0

### Minor Changes

- [#452](https://github.com/knpkv/npm/pull/452) [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade to Effect 4.0.0 stable. `effect` and every `@effect/*` dependency or peer dependency now require `4.0.0`; imports move from the removed `effect/unstable/*` paths to `effect/*`.

- [#434](https://github.com/knpkv/npm/pull/434) [`fa377ce`](https://github.com/knpkv/npm/commit/fa377ce975cccd594da8f7a370eb14f7f48d0039) Thanks [@konopkov](https://github.com/konopkov)! - Hide pull requests of accounts you switched off. Their rows stay cached, so re-enabling an account brings its pull requests back without a provider round trip, and a URL naming one still resolves — the TUI list, the web queue, and its filter sidebar simply stop listing them, and the review badge stops counting them.

## 0.16.0

### Minor Changes

- [#410](https://github.com/knpkv/npm/pull/410) [`161566b`](https://github.com/knpkv/npm/commit/161566bccefc349e99d39734c910605d85cf1866) Thanks [@konopkov](https://github.com/konopkov)! - Add Claude-native Relay review profiles and persist Relay settings immediately after save.

- [#399](https://github.com/knpkv/npm/pull/399) [`316eff1`](https://github.com/knpkv/npm/commit/316eff159bc44fa46d5d1ec68d4515990fb3d9a1) Thanks [@konopkov](https://github.com/konopkov)! - Prevent sandbox startup reconciliation races and preserve profile identity when an AWS account id is empty.

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
