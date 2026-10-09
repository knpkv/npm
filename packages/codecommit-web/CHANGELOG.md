# @knpkv/codecommit-web

## 0.29.0

### Minor Changes

- [#640](https://github.com/knpkv/npm/pull/640) [`c09fc0f`](https://github.com/knpkv/npm/commit/c09fc0f2e807546f5910a4e9240a7ce848d3e442) Thanks [@konopkov](https://github.com/konopkov)! - Relay in CodeCommit web can read a pull request's changed files at its current revision (`get_pull_request_diff`) and post a comment on one line (`post_line_comment`). A line comment is pinned to the revision it was written against: it is refused if the pull request has moved on, or if the line is outside the changes. The person confirms the exact file, side, line, revision and text first.

- [#640](https://github.com/knpkv/npm/pull/640) [`c09fc0f`](https://github.com/knpkv/npm/commit/c09fc0f2e807546f5910a4e9240a7ce848d3e442) Thanks [@konopkov](https://github.com/konopkov)! - CodeCommit web mounts the Relay harness under `/api/relay`: an event stream for the dock that re-checks the owner session every 15 seconds, routes to send, cancel and confirm, and backend status. A second server on the same home starts without Relay and says why, and Relay's comments go through the same permission prompt and audit log as review findings. A decision applies only to the session it was raised in, and an event stream that fails ends with `StreamFailed` instead of closing silently.

- [#640](https://github.com/knpkv/npm/pull/640) [`c09fc0f`](https://github.com/knpkv/npm/commit/c09fc0f2e807546f5910a4e9240a7ce848d3e442) Thanks [@konopkov](https://github.com/konopkov)! - Relay's event stream gives the dock what it renders without guessing:

  - `RunStarted` names the run.
  - Every tool call carries a display-safe summary, and a completed write carries its receipt (CodeCommit: the operation id and the pull request's console link).
  - `ConfirmationResolved` reports confirmed, declined or expired.
  - Snapshot messages have ids.
  - The session says whether its runs can be cancelled.

- [#640](https://github.com/knpkv/npm/pull/640) [`c09fc0f`](https://github.com/knpkv/npm/commit/c09fc0f2e807546f5910a4e9240a7ce848d3e442) Thanks [@konopkov](https://github.com/konopkov)! - A Relay message can carry context the person attached; the model reads it, but the transcript does not show it. CodeCommit web uses it to send the review findings the person is looking at, with the head they were reviewed at.

### Patch Changes

- [#640](https://github.com/knpkv/npm/pull/640) [`c09fc0f`](https://github.com/knpkv/npm/commit/c09fc0f2e807546f5910a4e9240a7ce848d3e442) Thanks [@konopkov](https://github.com/konopkov)! - Relay's mount takes its backends as a parameter, so tests can run the real mount on a scripted model. A new crash test proves it: CodeCommit web killed with SIGKILL in the middle of a confirmed comment resumes without posting it twice.

- [#711](https://github.com/knpkv/npm/pull/711) [`d8fcb1a`](https://github.com/knpkv/npm/commit/d8fcb1a3ab52db1e93464fda034737dca1272fa2) Thanks [@konopkov](https://github.com/konopkov)! - A dangling `~/.codecommit/relay` link now reports Relay as unavailable because the directory is a link, instead of saying it could not prepare its data directory.
- Updated dependencies [[`c09fc0f`](https://github.com/knpkv/npm/commit/c09fc0f2e807546f5910a4e9240a7ce848d3e442), [`c09fc0f`](https://github.com/knpkv/npm/commit/c09fc0f2e807546f5910a4e9240a7ce848d3e442), [`c09fc0f`](https://github.com/knpkv/npm/commit/c09fc0f2e807546f5910a4e9240a7ce848d3e442), [`c09fc0f`](https://github.com/knpkv/npm/commit/c09fc0f2e807546f5910a4e9240a7ce848d3e442), [`c09fc0f`](https://github.com/knpkv/npm/commit/c09fc0f2e807546f5910a4e9240a7ce848d3e442), [`4c21182`](https://github.com/knpkv/npm/commit/4c211825fc99debbdc85f4cb71ea4d566e51e26f), [`c09fc0f`](https://github.com/knpkv/npm/commit/c09fc0f2e807546f5910a4e9240a7ce848d3e442), [`5a93f2f`](https://github.com/knpkv/npm/commit/5a93f2fe9fdbab1978a7ae68832e46d00c2be693)]:
  - @knpkv/codecommit-core@0.25.0
  - @knpkv/relay@0.1.0

## 0.28.0

### Minor Changes

- [#613](https://github.com/knpkv/npm/pull/613) [`faddacc`](https://github.com/knpkv/npm/commit/faddacc829272ec3b580af00ee6e581294be76e7) Thanks [@konopkov](https://github.com/konopkov)! - A pull request URL for a switched-off account no longer spins on "Loading pull request" while every refresh returns 500. `refreshSinglePR` fails with `AccountSwitchedOff` (naming the profile) when a disabled profile owns the account, or with `AccountUnknown` when no profile is known to; the web API answers those with 409 and 404. The page says why it can't read the pull request, links to Settings → Accounts when that fixes it, and offers Try again for any other failure.

### Patch Changes

- [#682](https://github.com/knpkv/npm/pull/682) [`e2f406b`](https://github.com/knpkv/npm/commit/e2f406bc0e3941cc4d349aba844ec04822e82585) Thanks [@konopkov](https://github.com/konopkov)! - Settings → Audit: at narrow widths the action buttons wrap instead of the View Audit Log label spilling past its button.

- [#669](https://github.com/knpkv/npm/pull/669) [`fcbd310`](https://github.com/knpkv/npm/commit/fcbd310bc0de959847246d1d7b3b93fa944c6cd3) Thanks [@konopkov](https://github.com/konopkov)! - Nav labels no longer spill out of their pills at 320px; the row scrolls instead. Hover highlights apply only on devices that hover, so a tap no longer leaves a row or button highlighted.

- [#671](https://github.com/knpkv/npm/pull/671) [`28e5c8c`](https://github.com/knpkv/npm/commit/28e5c8ca02373f7b6cdcc9af4a25380e97ddb8fe) Thanks [@konopkov](https://github.com/konopkov)! - Small controls (filter chips, approver add/remove, the findings drawer's close, nav pills) get a 44px touch target without changing how they look, and buttons give press feedback.

- [#674](https://github.com/knpkv/npm/pull/674) [`3be1bf6`](https://github.com/knpkv/npm/commit/3be1bf63e9b6e933ba38063ebd23e6e84e0c4d22) Thanks [@konopkov](https://github.com/konopkov)! - Pages and the review workbench size to the phone's small viewport (`svh`), so they no longer run under the browser's toolbar; clipped boxes use `overflow: clip`.

- [#675](https://github.com/knpkv/npm/pull/675) [`6016906`](https://github.com/knpkv/npm/commit/60169060a04688084c7e47ebec4b28d538be9811) Thanks [@konopkov](https://github.com/konopkov)! - Motion in the review workbench, settings and the rolling status line is opt-in (only with no reduced-motion preference) and uses Relay's motion tokens, so the status line eases in 240ms instead of 350–400ms.

- [#687](https://github.com/knpkv/npm/pull/687) [`ab6b732`](https://github.com/knpkv/npm/commit/ab6b7329bcc49337a658abaaf708fba2ce9ced44) Thanks [@konopkov](https://github.com/konopkov)! - Browser builds now target Chrome 123, Edge 123, Firefox 120 and Safari 17.6, the floor the CSS already relies on for `light-dark()` and `safe` alignment. Before, they targeted Vite's default (Chrome 111, Safari 16.4), so Lightning CSS rewrote `light-dark()` into its custom-property polyfill. Built CSS now keeps `light-dark()` native. For `@knpkv/rly` consumers, the published stylesheet assumes those browsers.
- Updated dependencies [[`faddacc`](https://github.com/knpkv/npm/commit/faddacc829272ec3b580af00ee6e581294be76e7)]:
  - @knpkv/codecommit-core@0.24.0

## 0.27.0

### Minor Changes

- [#661](https://github.com/knpkv/npm/pull/661) [`26d9de9`](https://github.com/knpkv/npm/commit/26d9de9c64b78da62ab462856cbd09e9137eb40f) Thanks [@konopkov](https://github.com/konopkov)! - Relay opens from the app header (button or Ctrl/⌘+J) into one panel, replacing the fixed chip. A finding's "Discuss in Relay" opens the panel with that finding attached to the composer; the separate in-page discussion is gone, and earlier per-finding discussions stay readable in the PR thread, each named for what it was about. Run, profile and focus controls, progress and the findings deck stay in the page. No new AWS operations or permissions.

### Patch Changes

- [#612](https://github.com/knpkv/npm/pull/612) [`000d102`](https://github.com/knpkv/npm/commit/000d1022ea889bed988ec5c93754c2606c501e26) Thanks [@konopkov](https://github.com/konopkov)! - A refresh held back by the permission gate no longer reads "PermissionDeniedError:." It now says what is missing and where to fix it: "Couldn't list pull requests in dev (eu-central-1): Not allowed yet: the getPullRequests permission prompt has no answer. Allow it in Settings → Permissions." A provider error with no message is named without a dangling colon.
- Updated dependencies [[`000d102`](https://github.com/knpkv/npm/commit/000d1022ea889bed988ec5c93754c2606c501e26)]:
  - @knpkv/codecommit-core@0.23.1

## 0.26.2

### Patch Changes

- [#585](https://github.com/knpkv/npm/pull/585) [`2bc7cfa`](https://github.com/knpkv/npm/commit/2bc7cfa8678e43920eda987d2049d97f7a4ba58f) Thanks [@konopkov](https://github.com/konopkov)! - An approval revoked down to no approvers is now cleared. Approvers are who approved the pull request now, from the same read as the approval: a read with none clears them, and only a read that couldn't fetch them keeps the last known list. Before, a failed approver read and a real "no approvers" were the same empty list, and the cache kept the old approvers in both cases, so a revoked approval never cleared.

  - `fetchApprovers` returns `Option`: none when the read fails (logged as a warning), never an empty list standing in for a failure.
  - `PullRequest` and `PullRequestDetail` gain `approversUnknown` (set when the approver read failed; `approvedBy` is then only the last known list), and `UpsertInput` carries it.
  - Approvers now move with the approval group's version, so a read whose approval is older than the cached one doesn't overwrite them.
  - The cache keeps the marker (`approvers_unknown`, migration 0025; every row cached before it starts unknown, since its list may hold a revoked approval, until it is re-read), so a published pull request still says its approvers are only last known; the browser's wire schema decodes it.
  - A bulk refresh, listed or stale re-read, with a pull request whose approvers couldn't be read counts that account as partial, not clean.
  - `needsMyReview` and the workbench don't claim a definite review while approvers are unknown (the user may already have approved): the workbench lists such a pull request under the pool, and a last known approval never takes the user out of it.
  - `Domain` adds `approversUnknownLabel` and `currentApprovers` (none while approvers are unknown). The browser shows "Approvers unknown" instead of an approval count, rule progress or approver check marks, and approver filters offer and match only approvers known now.
  - Reviewer stats don't count approvers that couldn't be read, in top approvers or time to first review.
  - The approver read logs its failure where it recovers, so its silent-fallback baseline line is gone.
  - A merged or closed pull request is never listed again, so each refresh re-reads up to 25 of those with unknown approvers, oldest-updated first, until none is left. A failed re-read stays unknown and is logged, and never holds the refresh back. `PullRequestRepo` adds `findClosedWithUnknownApprovers`.
  - A credential failure on the approver read is no longer unknown approvers: it fails the read, so the account shows signed out.
  - `Domain` adds `currentApproverArns`. The `no-raw-pull-request-approvers-read` guard also covers `approvedByArns`, optional-chained and indexed reads.

- [#631](https://github.com/knpkv/npm/pull/631) [`2f2925b`](https://github.com/knpkv/npm/commit/2f2925b42d04686ca9da52c056f6d9a177548e05) Thanks [@konopkov](https://github.com/konopkov)! - First-run follow-ups. When more than one read waits for permission, the read bar names them ("2 reads are waiting: Get identity for dev and List PRs for dev"; three at most, then "and N more"), so "Allow every read" is plainly the one answer. `@knpkv/codecommit-core`: `PermissionGateLive.pendingOf(category, limit)` reports the prompts actually waiting in this process. Settings → Accounts says "Checking sign-in…" until an account's identity read answers, instead of "Not logged in" next to a live SSO profile, and a browser without a session gets the sign-in-link guidance in Settings instead of a pointer to the config file.

- [#628](https://github.com/knpkv/npm/pull/628) [`87c1f1b`](https://github.com/knpkv/npm/commit/87c1f1baae40c0e4351de976a6446c8c194e72df) Thanks [@konopkov](https://github.com/konopkov)! - Stats fits a 320px screen: its tiles and charts flow into as many columns as fit instead of three fixed ones. A notification's title wraps onto a second line instead of being cut off on a phone. Settings' tabs on a narrow or zoomed screen are laid out in columns by width, so the row no longer re-wraps and shifts the page when the web font arrives.

- [#635](https://github.com/knpkv/npm/pull/635) [`4ff1f03`](https://github.com/knpkv/npm/commit/4ff1f0386648e41cfee2d0198c7c30c312c60539) Thanks [@konopkov](https://github.com/konopkov)! - The read permission bar docks to the bottom edge instead of entering the page above it, so a prompt that arrives after the page has painted no longer pushes everything down (the Settings layout shift on a first run). The page keeps the bar's height free at its end. While the identity read waits for that permission, Settings → Accounts says "Waiting for read permission" instead of a sign-in state.

  The Relay chip sits above the docked bar instead of covering its answers: `@knpkv/relay-product`'s dock adds the host's `--app-bottom-inset` to its bottom offset. The bar's sentence is shorter, and Accounts says "Waiting for read permission" whenever any read waits.

- [#605](https://github.com/knpkv/npm/pull/605) [`0f93f9a`](https://github.com/knpkv/npm/commit/0f93f9a6310af21bade9563dcf45f8961436f0c0) Thanks [@konopkov](https://github.com/konopkov)! - The pull request page's review header is a flat panel instead of a provider-tinted one, and Relay's profile choice uses the design system's select (named, keyboard-navigable, styled in every theme) instead of the browser's default control. Inside the findings drawer its options open within the drawer, so they can be chosen.

- [#593](https://github.com/knpkv/npm/pull/593) [`dd7a33a`](https://github.com/knpkv/npm/commit/dd7a33a7377370f381ba67d4eb4f9e2bb4961597) Thanks [@konopkov](https://github.com/konopkov)! - Text no longer jumps when Geist loads. rly's font stacks fall back to metric-matched Arial, Liberation Sans or Arimo faces (and Courier New, Liberation Mono or Cousine for mono), sized per weight, so lines break and rows stand the same height before and after the swap wherever glyphs are placed at subpixels (desktop Chrome on Linux as measured, and the usual macOS and Windows defaults); a Linux desktop set to full hinting can still move text slightly. Reading measures and title widths are set in `em` (at the weight each is drawn in) rather than `ch`, whose size follows the font's "0" and changed by 16% on the swap. Product shells preload the Geist file their stylesheet loads, and review's offline guide no longer hides the page until its fonts are ready.

- [#639](https://github.com/knpkv/npm/pull/639) [`c33ead7`](https://github.com/knpkv/npm/commit/c33ead79cfcbcdb16bbb468229e5a35454e05998) Thanks [@konopkov](https://github.com/konopkov)! - The web app preloads Geist Mono as well as Geist, so ids and code text paint in the right face sooner and don't re-wrap a line when the font arrives.
- Updated dependencies [[`2bc7cfa`](https://github.com/knpkv/npm/commit/2bc7cfa8678e43920eda987d2049d97f7a4ba58f), [`2f2925b`](https://github.com/knpkv/npm/commit/2f2925b42d04686ca9da52c056f6d9a177548e05)]:
  - @knpkv/codecommit-core@0.23.0

## 0.26.1

### Patch Changes

- [#607](https://github.com/knpkv/npm/pull/607) [`a840102`](https://github.com/knpkv/npm/commit/a840102bb71e6777c996b20050074881503d9850) Thanks [@konopkov](https://github.com/konopkov)! - A failing live update no longer pushes its message over the header's navigation or cuts it to an ellipsis: the header shows the status word ("Reconnecting") with its full reason as the status's hover text and accessible name, and spells the reason out inline only on screens wide enough for it.

- [#592](https://github.com/knpkv/npm/pull/592) [`8f8ca48`](https://github.com/knpkv/npm/commit/8f8ca48df183417ba93e927713731abb9cd9c616) Thanks [@konopkov](https://github.com/konopkov)! - A failed statistics or settings read is stated on the page with its cause and a Try again button, instead of replacing the app with an error screen. Each settings tab and Statistics has one level-one heading. Links inside a sentence carry an underline with at least 3:1 contrast. The current page in the navigation stays marked in forced colours.

## 0.26.0

### Minor Changes

- [#603](https://github.com/knpkv/npm/pull/603) [`4ecc3c2`](https://github.com/knpkv/npm/commit/4ecc3c249223f4999e6c7aa868cfa044267412f7) Thanks [@konopkov](https://github.com/konopkov)! - Pull requests whose approval is unknown are said apart from "waiting on your review": the queue's summary adds "N pull requests with approval unknown", naming the reason when they all share one, and only when there are any. A row's "Approval unknown" carries its reason as hover text and as the row's accessible description, in the queue and in the rail.

### Patch Changes

- [#606](https://github.com/knpkv/npm/pull/606) [`d73f798`](https://github.com/knpkv/npm/commit/d73f7988432fbecedde47885f610908d4c405a35) Thanks [@konopkov](https://github.com/konopkov)! - Settings → Relay writes a profile's model, provider and harness as a phrase ("default on codex, through native-codex") and a skill's source on its own line, instead of joining them with middots.

## 0.25.0

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

- [#587](https://github.com/knpkv/npm/pull/587) [`d6fb196`](https://github.com/knpkv/npm/commit/d6fb196aaaac44e83450474b345038879f88185a) Thanks [@konopkov](https://github.com/konopkov)! - Installing codecommit no longer downloads the web client's build tooling and browser libraries: the client ships prebuilt, so vite, tailwind, react-dom and the rest are devDependencies of codecommit-web, and codecommit drops an unused tslib.

- [#581](https://github.com/knpkv/npm/pull/581) [`c22e8ae`](https://github.com/knpkv/npm/commit/c22e8ae0c55a50e9c1edbd46a1cd18108f62e4fa) Thanks [@konopkov](https://github.com/konopkov)! - Mark existing silent fallbacks (failures turned into success without a log) with a follow-up lint suppression. No behaviour change.
- Updated dependencies [[`0938903`](https://github.com/knpkv/npm/commit/0938903a17b6d2bdf13b96947471a1d49f10b42f), [`c22e8ae`](https://github.com/knpkv/npm/commit/c22e8ae0c55a50e9c1edbd46a1cd18108f62e4fa)]:
  - @knpkv/codecommit-core@0.22.0
  - @knpkv/ai-claude@0.4.2
  - @knpkv/ai-codex@0.5.2

## 0.24.0

### Minor Changes

- [#569](https://github.com/knpkv/npm/pull/569) [`5509cb8`](https://github.com/knpkv/npm/commit/5509cb87f90641d14211e2d993443e3cfcf40784) Thanks [@konopkov](https://github.com/konopkov)! - Approval and health now read honestly on real queues.

  - `approvalOf` gains `NotRequired`, labelled "No approval required" (`approvalNotRequiredLabel`): CodeCommit evaluates a pull request with no approval rules as approved, though nobody signed off. "Approved" now appears only when rules exist and are satisfied. The CLI flags, TUI badge, web row, detail page and health score all show it. Status filters and counts treat it as neither approved nor pending.
  - No "Approval granted" or "revoked" notification is sent for a pull request without rules. An identical pull-request notification that is still unread is not added again, so a restart no longer re-announces it.
  - The cache records whether a pull request's approval baseline is known (migration 0024). A sign-off or withdrawal made while approval evaluation was failing is announced once evaluation recovers. A pull request first seen while evaluation fails holds only a placeholder, so its recovery is not announced.
  - The health score uses a saturating curve: a base of 8, minus up to 6 for idleness and up to 2 for age, plus up to 1.5 for comments (3 counted), 2 for an approval and 1 for "No approval required". Long-idle pull requests are now ranked instead of all reading 0.0, and fresh ones stay green. A pull request CodeCommit gave no dates for scores Unknown ("Health —") and sorts last; comments that haven't loaded make the score a lower bound.

- [#503](https://github.com/knpkv/npm/pull/503) [`281ce63`](https://github.com/knpkv/npm/commit/281ce63fec174b26c0c306b58ca4c473e83f9cc8) Thanks [@konopkov](https://github.com/konopkov)! - The Relay findings pane follows the space the pull request page actually has: a third column on wide windows, a "Findings" drawer beside the diff on medium ones (Esc closes it and returns focus), stacked below the diff on phones. Finding and line-comment highlights use a full 1px border instead of a thick stripe.

### Patch Changes

- [#575](https://github.com/knpkv/npm/pull/575) [`655f010`](https://github.com/knpkv/npm/commit/655f010c2bb14b4118d81c60025ac64006b73f1c) Thanks [@konopkov](https://github.com/konopkov)! - Focus rings match rly's: a solid 2px outline in the focus colour, 2px outside the control, from `--rly-focus-ring-width` and `--rly-focus-ring-offset`. Hand-rolled 1px to 3px rings, rings in agent, service or text colours, tinted halos and box-shadow rings are gone. Rings inside clipped containers pull the ring width inside.

- [#568](https://github.com/knpkv/npm/pull/568) [`442b11d`](https://github.com/knpkv/npm/commit/442b11db369a5af5e85d4d91d00c334d46f8103d) Thanks [@konopkov](https://github.com/konopkov)! - The test suites of codecommit-core and codecommit-web are now typechecked as part of `check`, and both packages leave the test-typecheck allowlist.

- [#570](https://github.com/knpkv/npm/pull/570) [`c45b069`](https://github.com/knpkv/npm/commit/c45b069af37c78464332907fcb5cbe5903abf8a9) Thanks [@konopkov](https://github.com/konopkov)! - Executables linked from the repository (`pnpm link --global`, or `node dist/...`) run under plain Node: workspace packages resolve to their build output instead of TypeScript sources. Published `@knpkv/codecommit-core` now serves its `Domain.js`, `CacheService.js` and `SandboxService.js` subpaths; the last two resolved to files that do not exist before.
- Updated dependencies [[`5509cb8`](https://github.com/knpkv/npm/commit/5509cb87f90641d14211e2d993443e3cfcf40784), [`0a0182c`](https://github.com/knpkv/npm/commit/0a0182c18f237ab420d17d0339f0969d9356c63a), [`655f010`](https://github.com/knpkv/npm/commit/655f010c2bb14b4118d81c60025ac64006b73f1c), [`4965043`](https://github.com/knpkv/npm/commit/4965043541a324f630b847ed4d852b6722f6efe6), [`442b11d`](https://github.com/knpkv/npm/commit/442b11db369a5af5e85d4d91d00c334d46f8103d), [`c45b069`](https://github.com/knpkv/npm/commit/c45b069af37c78464332907fcb5cbe5903abf8a9)]:
  - @knpkv/codecommit-core@0.21.0
  - @knpkv/review@0.4.2
  - @knpkv/rly@0.12.0
  - @knpkv/relay-product@0.2.6

## 0.23.0

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

### Patch Changes

- [#519](https://github.com/knpkv/npm/pull/519) [`6d215b2`](https://github.com/knpkv/npm/commit/6d215b2fa9bb3e98f447efbbddcb299c41a4efc5) Thanks [@konopkov](https://github.com/konopkov)! - No one-sided accent stripes in the CodeCommit app:

  - The pull request's revision panel is a flat panel without the orange edge and tint.
  - Reply threads are shown by indentation.
  - Finding and comment lines in the diff have an even border.
  - The Relay pane is separated by a hairline.
  - A selected finding shows a background and `aria-current`, not an edge bar.
  - Your own Relay turns sit on a deeper surface.
  - The sandbox eyebrow loses its bar.
  - rly components are no longer reset by Tailwind's preflight: page titles, buttons and state panels get their rly styles again.
  - Metadata reads as plain text ("ana, 2h ago"; "Pull request 12, created …, port 8080") instead of dot-separated lists.

- [#532](https://github.com/knpkv/npm/pull/532) [`8f64bdf`](https://github.com/knpkv/npm/commit/8f64bdfee2ab758c53d0555850be42cfe9f3626e) Thanks [@konopkov](https://github.com/konopkov)! - Refreshing a pull request that has an approval rule works again, and the rule shows its approvers.

  - The cache's upsert input required `ApprovalRule` class instances, but the single-PR refresh passes the provider's rules as plain objects, so every refresh of such a PR failed (HTTP 500 in codecommit-web). `UpsertInput.approvalRules` now accepts the rule's plain shape.
  - Rule content whose `ApprovalPoolMembers` is a single string, such as `"*"`, is read as a one-member pool instead of failing to parse and showing no approvers. A rule that can't be parsed now logs the schema error with its path.
  - codecommit-web logs the cause of a failed refresh, and the PR page shares one in-flight refresh per pull request, so overlapping triggers no longer cancel each other.

- Updated dependencies [[`fd9d510`](https://github.com/knpkv/npm/commit/fd9d5103e3558561274b16c258023bee73b4b233), [`3a59848`](https://github.com/knpkv/npm/commit/3a598483979960e71bfc880f182c73d499001091), [`286f23e`](https://github.com/knpkv/npm/commit/286f23ece7fc85b9a7a754b7b5f96b5e65868244), [`6d215b2`](https://github.com/knpkv/npm/commit/6d215b2fa9bb3e98f447efbbddcb299c41a4efc5), [`8f64bdf`](https://github.com/knpkv/npm/commit/8f64bdfee2ab758c53d0555850be42cfe9f3626e)]:
  - @knpkv/codecommit-core@0.20.0
  - @knpkv/rly@0.11.0
  - @knpkv/relay-product@0.2.5
  - @knpkv/review@0.4.1

## 0.22.0

### Minor Changes

- [#522](https://github.com/knpkv/npm/pull/522) [`da4b5eb`](https://github.com/knpkv/npm/commit/da4b5eb15e627c0dae13aa92a3ec0c848ab6225b) Thanks [@konopkov](https://github.com/konopkov)! - `AppState.callerIdentities` records who the caller is in every enabled account, keyed by AWS profile. Before, only `currentUser` existed, taken from the first enabled account alone. Each entry is `Resolved` (`accountId`, `arn`, `username`) or `Unresolved` with a typed `reason`: `CredentialsUnavailable`, `StsRejected` or `Throttled` from the identity lookup's error type, `RefreshAuthFailed` when a pull-request refresh hits an authentication error, or `SignedOut` after `aws sso logout`. `@knpkv/codecommit-core/Domain` exports the `CallerIdentityState`, `CallerIdentityUnresolvedReason` and `CallerIdentities` schemas, and `AwsClient.CallerIdentity` gains `arn`. The codecommit-web event stream sends `callerIdentities`, so the browser can match wildcard approval pools against the caller's exact ARN in each account. Identity is one state machine, `@knpkv/codecommit-core/IdentityLifecycle`: a single `transition` over identity events is the only writer, so a refresh, login or logout that happens meanwhile makes older in-flight work a no-op. SSO login and logout refresh right away. `currentUser` is now derived from the first enabled account's identity only, so signing in to another account no longer replaces it. `signInState` and `signOutState` move from `Domain` to `IdentityLifecycle`. The event stream also sends `unevaluatedPullRequests`: the pull requests the last refresh kept from cache because their approval rules failed to evaluate. `@knpkv/codecommit-core/Domain` exports it as an `UnevaluatedPullRequest` schema. Signing out of AWS SSO in codecommit-web now asks first: `aws sso logout` ends every SSO session on the machine, including other tools' sessions, and the confirmation says so and offers switching one account off instead. All three sign-out controls go through it. Success and failure are both notified; a failure names the command and its exit code or timeout. A failed `aws sso login` no longer counts as signed in.

### Patch Changes

- [#533](https://github.com/knpkv/npm/pull/533) [`df61da3`](https://github.com/knpkv/npm/commit/df61da3e1caf872125306e7912b5cb0cfc7d8de6) Thanks [@konopkov](https://github.com/konopkov)! - The `codecommit` executable starts with Node: `--help`, the `pr` commands and `codecommit web` no longer need Bun. Before, the executable's shebang was `#!/usr/bin/env bun`, so a Node-only install failed with `exec: bun: not found`. The terminal UI still runs on Bun, because OpenTUI does. With Bun on `PATH`, `codecommit` under Node hands the terminal UI to it. Without Bun, it exits with one line saying so and suggesting `codecommit web`. The web server now uses Node's HTTP server, which also runs under Bun.

- [#509](https://github.com/knpkv/npm/pull/509) [`c93baf2`](https://github.com/knpkv/npm/commit/c93baf29bba9d67ffc4938ce0b0ada533260fddc) Thanks [@konopkov](https://github.com/konopkov)! - Controls default to tool density: `Button`, `IconButton`, `Select`, and the `Field` control gain a `dense` size (32px, small radius, sized to text) and use it when no size is given (`ThemeSelect` and the `AgentJob` cancel action too), through new shared `--rly-control-height-*` tokens (`RLY_CONTROL_HEIGHT_TOKEN_NAMES`). Compact `IconButton` is 40px like the other compact controls (it was 44). `ToggleGroup` gains the same dense default, drawn as an outlined row with 1px dividers instead of a tinted track, and its `compact` and `default` sizes now follow the 40px and 48px control heights; the registry lists `dense` as the default size. Coarse pointers keep a 44px target. One-sided accent stripes are gone from rly: diff annotations, the file-tree error, stale findings, agent outcomes, thread evidence, verdict reasons, workset gaps, and the `StatePanel` rail now use an even border or a flat tint, and `lint:stripes`, now part of the repository lint gate, keeps them from coming back. The diff file tree marks the open file with an even ring and draws its guide lines in the neutral divider colour. A neutral `StatePanel` shows no icon unless `icon` names one. Control Center's header actions, Settings inputs and selects, and service setup fields move to the same dense height, so they line up with rly buttons.

  `StateLabel` renders a state as its word and icon in the tone's ink, with no border, tint or padding, so it never reads as a status chip. rly text no longer uses `overflow-wrap: anywhere`: words wrap only between words, and only an unbreakable token breaks (`break-word`), so a squeezed row never splits a word. Control Center Services: the card header keeps the title whole beside its state, and resource rows and test evidence lose their one-sided stripes. Codecommit-web's pull-request state links keep the 32px control target now that the state is a plain word.

- Updated dependencies [[`44b633d`](https://github.com/knpkv/npm/commit/44b633d87c8b98ddb3fd03225124fa996e563473), [`c01672d`](https://github.com/knpkv/npm/commit/c01672d8d55cd93580c06958e8cc202f5cde90c6), [`da4b5eb`](https://github.com/knpkv/npm/commit/da4b5eb15e627c0dae13aa92a3ec0c848ab6225b), [`6940d1b`](https://github.com/knpkv/npm/commit/6940d1b6c88c3b95a3d70ad84a13f011c6fa4017), [`702d855`](https://github.com/knpkv/npm/commit/702d8559efbd781f4f89131ddbe462137a85ba4d), [`c93baf2`](https://github.com/knpkv/npm/commit/c93baf29bba9d67ffc4938ce0b0ada533260fddc)]:
  - @knpkv/codecommit-core@0.19.0
  - @knpkv/review@0.4.0
  - @knpkv/rly@0.10.0
  - @knpkv/relay-product@0.2.4

## 0.21.0

### Minor Changes

- [#493](https://github.com/knpkv/npm/pull/493) [`e45eba3`](https://github.com/knpkv/npm/commit/e45eba30991dc662b7a8b09506d2d85b878fec97) Thanks [@konopkov](https://github.com/konopkov)! - `@knpkv/browser-pairing/owner-session` adds `serveWithBootstrapUrl(server, onReady)`. It runs a server layer, waits until it is listening, hands its bootstrap URL to `onReady`, and keeps serving. A launch that fails before it is listening fails without announcing a URL, and a failing `onReady` stops the server. `agent-usage serve`, `jcf-web` and `codecommit-web` now start their servers through it instead of three copies of that code. `@knpkv/codecommit-web` also exports `serveCodeCommit(options)` (`hostname`, `port`, `onReady`), the start sequence its own entry uses.

### Patch Changes

- [#495](https://github.com/knpkv/npm/pull/495) [`34cfd71`](https://github.com/knpkv/npm/commit/34cfd71a66f76a25313637036e5d5324982ee236) Thanks [@konopkov](https://github.com/konopkov)! - The queue rail stays below the app header at the bottom of a long pull request page; it used to slide under the header by the page's bottom padding.

- [#507](https://github.com/knpkv/npm/pull/507) [`ceb59a9`](https://github.com/knpkv/npm/commit/ceb59a90f535a15c164c7e4e373366ab45acd699) Thanks [@konopkov](https://github.com/konopkov)! - The review queue model takes the caller's per-account identity, ready for the server to publish it: once an account's identity resolves, the caller's ARN decides wildcard role pools exactly, and an approval by another session of the same role no longer counts as yours. Until then nothing changes; every account keeps the user-name rules.
- Updated dependencies [[`43ab828`](https://github.com/knpkv/npm/commit/43ab8288a02a03924c66b5488d20ac7576e348e1), [`934843b`](https://github.com/knpkv/npm/commit/934843bbcea57cbf3266fce950c020733046cac1), [`148daa6`](https://github.com/knpkv/npm/commit/148daa6be147dca74bc642bd552b603deb760eae), [`4e8f346`](https://github.com/knpkv/npm/commit/4e8f346b926b859ea2b3be07ec7dc6cb77ca8e76), [`e57bb6d`](https://github.com/knpkv/npm/commit/e57bb6db1b393dbff8e116573cf2db23992c1cf4), [`7df3dbb`](https://github.com/knpkv/npm/commit/7df3dbb9875ab31f369351df2de898b36d40e613), [`8924289`](https://github.com/knpkv/npm/commit/89242895271072b83185d6cc02376b2c56830f6a), [`f8d2612`](https://github.com/knpkv/npm/commit/f8d2612e09b20974dd8eccc8ff197bb072c40cbf), [`e45eba3`](https://github.com/knpkv/npm/commit/e45eba30991dc662b7a8b09506d2d85b878fec97)]:
  - @knpkv/codecommit-core@0.18.0
  - @knpkv/rly@0.9.0
  - @knpkv/browser-pairing@0.4.0
  - @knpkv/relay-product@0.2.3
  - @knpkv/review@0.3.3

## 0.20.0

### Minor Changes

- [#492](https://github.com/knpkv/npm/pull/492) [`139ec4f`](https://github.com/knpkv/npm/commit/139ec4f66f1b790cb1364d1171a49f48496a60b8) Thanks [@konopkov](https://github.com/konopkov)! - Pull request pages now show the review queue beside the pull request in windows 800px and wider: what needs your review, what waits on a role pool you may be in, your own pull requests with the reason each is stuck, and what you are watching. The open pull request is marked, and arrow keys move through the list. Phones and 768px tablets keep the pull request alone.

  Enter on a focused link or button on a pull request page now does only that, instead of also opening the AWS console.

  The review count on the Pull requests tab, the review reminder, the pull request list's "needs my review" filter and the queue now count the same pull requests. A rule with no approval pool asks everyone but the author for review, and a pull request waiting only on a wildcard role pool is listed apart, not counted.

  The live events stream no longer sends `pendingReviewCount`; the web client counts reviews itself. `AppState.pendingReviewCount` in codecommit-core is documented as unused by the web app.

### Patch Changes

- [#482](https://github.com/knpkv/npm/pull/482) [`a96616b`](https://github.com/knpkv/npm/commit/a96616bbea8a407f073563b8c6a8916c278e7e50) Thanks [@konopkov](https://github.com/konopkov)! - Remove the unreachable Control Center prototype fixtures. Nothing reachable changes.

- [#488](https://github.com/knpkv/npm/pull/488) [`300c6fe`](https://github.com/knpkv/npm/commit/300c6fedd3e10c652a67a5e0b18e456b6b706353) Thanks [@konopkov](https://github.com/konopkov)! - Add the review Workbench queue model: which open pull requests need your review, which are yours and why they are stuck, and which you are watching. Nothing renders it yet.
- Updated dependencies [[`487f2ba`](https://github.com/knpkv/npm/commit/487f2ba4fdb585f0cd0b2ab96fd4eeedce9da10d), [`139ec4f`](https://github.com/knpkv/npm/commit/139ec4f66f1b790cb1364d1171a49f48496a60b8)]:
  - @knpkv/rly@0.8.0
  - @knpkv/codecommit-core@0.17.1
  - @knpkv/relay-product@0.2.2
  - @knpkv/review@0.3.2

## 0.19.1

### Patch Changes

- Updated dependencies [[`d5ee299`](https://github.com/knpkv/npm/commit/d5ee299ce3fa5584f2f54051009828af4a26fe4b)]:
  - @knpkv/rly@0.7.0
  - @knpkv/relay-product@0.2.1
  - @knpkv/review@0.3.1

## 0.19.0

### Minor Changes

- [#468](https://github.com/knpkv/npm/pull/468) [`0fef7fb`](https://github.com/knpkv/npm/commit/0fef7fb84162380cf1f713ed40e98a5ccbdde804) Thanks [@konopkov](https://github.com/konopkov)! - Serve the built client with Effect's `HttpStaticServer` instead of three hand-rolled routers. jcf-web and agent-usage export `staticClient(root)` from `server/HttpApplication.js` in place of `isWithinDirectory`; jcf-web also exports `apiApplication` and `StaticRouter`, the two halves `application` merges, so a host can give the static client its own FileSystem. Visible changes: responses carry `Cache-Control: no-cache` plus ETag/304 and byte-range support, content types include a charset, only extensionless HTML navigations fall back to `index.html` (a missing `*.js` or an index-less directory is now 404), and a malformed percent-encoded path is a 404 (previously 500 in jcf-web and codecommit-web, 400 in agent-usage). codecommit-web's traversal guard no longer accepts sibling directories that share the client directory's name prefix.

### Patch Changes

- Updated dependencies [[`0fd9544`](https://github.com/knpkv/npm/commit/0fd95449194e83de61109d432224acc043f57964)]:
  - @knpkv/ai-claude@0.4.1
  - @knpkv/ai-codex@0.5.1

## 0.18.0

### Minor Changes

- [#466](https://github.com/knpkv/npm/pull/466) [`f93ed3f`](https://github.com/knpkv/npm/commit/f93ed3f800ff7633c58389b27d3d6e99ff553fd0) Thanks [@konopkov](https://github.com/konopkov)! - Use the shared `@knpkv/browser-pairing/owner-session`. `makeOwnerSessionSecrets`, `ownerSessionOrigin`, `ownerSessionUrl`, `ownerSessionUrlForOrigin`, `requireLoopbackOrigin` and the secrets contract are replaced by `makeOwnerSession`, `loopbackOrigin` and `requireLoopbackHostname`; `makeServer` takes an optional `publicOrigin` and its `ready` resolves with the bootstrap URL.

  BEHAVIOUR: API reads now apply Fetch Metadata, as jcf-web and agent-usage already did — a browser read marked cross-site, or same-site/`none` without the bound Origin, gets 403. Same-origin page requests and explicit clients without Fetch Metadata are unaffected.

### Patch Changes

- Updated dependencies [[`f93ed3f`](https://github.com/knpkv/npm/commit/f93ed3f800ff7633c58389b27d3d6e99ff553fd0)]:
  - @knpkv/browser-pairing@0.3.0

## 0.17.0

### Minor Changes

- [#452](https://github.com/knpkv/npm/pull/452) [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade to Effect 4.0.0 stable. `effect` and every `@effect/*` dependency or peer dependency now require `4.0.0`; imports move from the removed `effect/unstable/*` paths to `effect/*`.

- [#434](https://github.com/knpkv/npm/pull/434) [`fa377ce`](https://github.com/knpkv/npm/commit/fa377ce975cccd594da8f7a370eb14f7f48d0039) Thanks [@konopkov](https://github.com/konopkov)! - Hide pull requests of accounts you switched off. Their rows stay cached, so re-enabling an account brings its pull requests back without a provider round trip, and a URL naming one still resolves — the TUI list, the web queue, and its filter sidebar simply stop listing them, and the review badge stops counting them.

- [#408](https://github.com/knpkv/npm/pull/408) [`08a1c42`](https://github.com/knpkv/npm/commit/08a1c42ba3e9c4505919477f8b601262fb07952e) Thanks [@konopkov](https://github.com/konopkov)! - Share typed, redacted browser-pairing credentials and transport primitives between Control Center and CodeCommit.

### Patch Changes

- [#432](https://github.com/knpkv/npm/pull/432) [`b2d229d`](https://github.com/knpkv/npm/commit/b2d229d2208fb9e7f2d9dc174ff12d769c5b8225) Thanks [@konopkov](https://github.com/konopkov)! - Replace employer-specific names in fixtures, comments and prototype storage keys with neutral placeholders.

  The Control Center prototype uses a new demo storage namespace. Saved prototype state and theme preferences from the previous namespace are not loaded.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Replace internal project names, keys and work descriptions in fixtures, examples and documentation
  with neutral placeholders. Nothing about behaviour changes; these are the strings a reader of a
  public package would otherwise see.

  `ClockifyApiClient`'s tests now compose their client once through `it.layer`, with each case
  declaring the response it wants, instead of providing a layer inside every test body.

- Updated dependencies [[`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`adfad78`](https://github.com/knpkv/npm/commit/adfad78662f20b698a2c6d76a70e824c52e22029), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e), [`b2d229d`](https://github.com/knpkv/npm/commit/b2d229d2208fb9e7f2d9dc174ff12d769c5b8225), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`8022091`](https://github.com/knpkv/npm/commit/802209142207593461eaef384d31757f746a2452), [`fa377ce`](https://github.com/knpkv/npm/commit/fa377ce975cccd594da8f7a370eb14f7f48d0039), [`fa695f0`](https://github.com/knpkv/npm/commit/fa695f0179c67701e468fcedcd07c4b738c9734a), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`08a1c42`](https://github.com/knpkv/npm/commit/08a1c42ba3e9c4505919477f8b601262fb07952e), [`af0c0e0`](https://github.com/knpkv/npm/commit/af0c0e09ef9ceabda7fd819bced7eb6d1b33e3c3), [`6ce5d6a`](https://github.com/knpkv/npm/commit/6ce5d6a1919515b9701ba0f0ec78c01cb408b623), [`fecd5b0`](https://github.com/knpkv/npm/commit/fecd5b05e26df62f87ea0f66f226cefdb685cc59)]:
  - @knpkv/ai-claude@0.4.0
  - @knpkv/rly@0.6.0
  - @knpkv/ai-codex@0.5.0
  - @knpkv/browser-pairing@0.2.0
  - @knpkv/codecommit-core@0.17.0
  - @knpkv/relay-product@0.2.0
  - @knpkv/review@0.3.0

## 0.16.0

### Minor Changes

- [#410](https://github.com/knpkv/npm/pull/410) [`161566b`](https://github.com/knpkv/npm/commit/161566bccefc349e99d39734c910605d85cf1866) Thanks [@konopkov](https://github.com/konopkov)! - Add Claude-native Relay review profiles and persist Relay settings immediately after save.

- [#399](https://github.com/knpkv/npm/pull/399) [`316eff1`](https://github.com/knpkv/npm/commit/316eff159bc44fa46d5d1ec68d4515990fb3d9a1) Thanks [@konopkov](https://github.com/konopkov)! - Prevent sandbox startup reconciliation races and preserve profile identity when an AWS account id is empty.

### Patch Changes

- Updated dependencies [[`161566b`](https://github.com/knpkv/npm/commit/161566bccefc349e99d39734c910605d85cf1866), [`1dcc473`](https://github.com/knpkv/npm/commit/1dcc473ebd14c2a4ac00d7fd67bf9a8d80201f66), [`316eff1`](https://github.com/knpkv/npm/commit/316eff159bc44fa46d5d1ec68d4515990fb3d9a1)]:
  - @knpkv/ai-claude@0.3.0
  - @knpkv/codecommit-core@0.16.0
  - @knpkv/rly@0.5.1

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
