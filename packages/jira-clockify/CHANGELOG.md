# @knpkv/jira-clockify

## 1.3.0

### Minor Changes

- [#383](https://github.com/knpkv/npm/pull/383) [`7c982c9`](https://github.com/knpkv/npm/commit/7c982c9f0ec56a65adff1275182a30f43f0eb0ee) Thanks [@konopkov](https://github.com/konopkov)! - Bound `jcf timer status` to roughly one run per machine per interval, however
  many Neovim instances are open, instead of one run per editor.

  Two files beside jcf's fixed `~/.jcf/state.json` do it. A util-linux `flock` on
  `poll.lock` stops two editors reconciling at once. The lock is attached to the
  `jcf` process itself, so a killed editor cannot release it while its poll is
  still running. A `poll.stamp` then bounds the rate: `jcf` checks and writes it
  while holding the lock, and a stamp younger than one interval means a managed
  attempt already finished. Failed attempts are stamped too, so a persistent
  failure cannot make every editor retry inside the same interval; readers keep
  the last state file until the next attempt.

  The first poll after `start_poll` is jittered by `pid % interval_ms` so editors
  opened in a batch do not line up on the same millisecond.

## 1.2.1

### Patch Changes

- [#361](https://github.com/knpkv/npm/pull/361) [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade the workspace to Effect 4.0.0-rc.109, pin the vendored Effect reference to that exact upstream release, guard source/package alignment, and bound Control Center test concurrency for reliable CI execution.
- Updated dependencies [[`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2)]:
  - @knpkv/agent-skills@0.3.1
  - @knpkv/atlassian-common@1.4.1
  - @knpkv/clockify-api-client@1.1.1
  - @knpkv/jira-api-client@1.1.1
  - @knpkv/jira-cli@1.3.1

## 1.2.0

### Minor Changes

- [#370](https://github.com/knpkv/npm/pull/370) [`27d2ca1`](https://github.com/knpkv/npm/commit/27d2ca18b0c0b0f8a252d461c0aaf10eb92e9ffc) Thanks [@konopkov](https://github.com/konopkov)! - Enforce the complete anti-slop rule set with zero accepted diagnostics and update affected APIs and implementations to satisfy the required contracts.

### Patch Changes

- [#358](https://github.com/knpkv/npm/pull/358) [`503d345`](https://github.com/knpkv/npm/commit/503d3459b419a3c9fd366715d5916e41086f493d) Thanks [@konopkov](https://github.com/konopkov)! - Stop the nvim statusline poll from leaking `jcf timer status` processes, and
  bound the command's Clockify calls.

  The poll spawned `jcf timer status` with `detach = true` on every tick and never
  waited for it. `status` does network I/O with no timeout, so a stalled request
  kept its process alive indefinitely — and because the process was detached,
  neither `VimLeave` nor `jobstop` could reap it. One nvim runs per project, so
  every stalled poll was multiplied by the number of open editors.

  Now at most one poll is in flight at a time, owned by nvim rather than detached,
  under a watchdog; the spawn is skipped entirely when no timer is running
  locally, since there is nothing to reconcile. On the CLI side the four Clockify
  calls in the command are each bounded, so a stalled one degrades to printing
  local state instead of pinning the process open.

  The other thing that can stall a `status` run is the Jira auth config, built
  before any command body runs, where an expired OAuth token triggers a network
  refresh — and that matters for `status` invoked outside nvim too, which no
  watchdog protects. The bound for it lives in `@knpkv/jira-cli`'s
  `refreshTokenImpl` rather than here: the rotation is uninterruptible, so a
  timeout on this call would be inert, and this layer is also the TUI's memoized
  runtime, where degrading to an empty credential would 401 every Jira call for
  the rest of the session. The nvim watchdog now sends SIGTERM with a grace period
  longer than that refresh deadline before escalating, so a rotation in flight can
  finish rather than being killed halfway.

  Bounding the lookup made a hung request indistinguishable from the API
  answering "no timer running" — both produce `null` — so the bound is applied
  under the reachability check that gates clearing the state file, not around it.
  `timer status` is what deletes local timer state unprompted, and the new test
  suite pins that a lookup which times out — or answers after the deadline —
  leaves the state file alone. The pipe ordering itself is only observable on an
  exact tie between answer and deadline, which has no deterministic winner to
  assert on, so it is held by a comment rather than a fixture.

  Also fixes a state-cache bug this surfaced: the Lua reader invalidated on
  whole-second mtime, so a timer started in the same filesystem second as the
  previous read stayed invisible. Harmless when the poll ran unconditionally, but
  the poll is now gated on that reading — a stale "inactive" would have suppressed
  the refresh that fixes it. The cache key now includes sub-second mtime and size.

  The Lua half ships with the package but was previously untested. It now has
  specs that stub job control and time and run under `nvim --headless`, wired into
  the vitest gate. They cover the single-flight invariant — including that a job
  which ignores SIGTERM keeps holding the guard rather than letting a second poll
  start — and the same-second cache write. The check workflow installs neovim so
  they actually run; the suite skips only for local dev without the binary, and
  fails rather than skipping when `CI` is set.

- [#361](https://github.com/knpkv/npm/pull/361) [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2) Thanks [@konopkov](https://github.com/konopkov)! - Update Effect and effect-qb, migrate schema-tagged errors to the current Effect API, and adopt the dialect-scoped SQLite function and type APIs introduced by effect-qb 0.22.
- Updated dependencies [[`503d345`](https://github.com/knpkv/npm/commit/503d3459b419a3c9fd366715d5916e41086f493d), [`503d345`](https://github.com/knpkv/npm/commit/503d3459b419a3c9fd366715d5916e41086f493d), [`b08ca20`](https://github.com/knpkv/npm/commit/b08ca2004b3efcd72a695b44c72b56dae20afdfd), [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2), [`b08ca20`](https://github.com/knpkv/npm/commit/b08ca2004b3efcd72a695b44c72b56dae20afdfd), [`2e26e30`](https://github.com/knpkv/npm/commit/2e26e3032ce527260a4e4d9fca8af43039f762d6), [`77e3257`](https://github.com/knpkv/npm/commit/77e3257743aacfaf9e11e016a60206f416c5fe79), [`27d2ca1`](https://github.com/knpkv/npm/commit/27d2ca18b0c0b0f8a252d461c0aaf10eb92e9ffc)]:
  - @knpkv/jira-cli@1.3.0
  - @knpkv/atlassian-common@1.4.0
  - @knpkv/agent-skills@0.3.0
  - @knpkv/clockify-api-client@1.1.0
  - @knpkv/jira-api-client@1.1.0

## 1.1.5

### Patch Changes

- [#345](https://github.com/knpkv/npm/pull/345) [`471974f`](https://github.com/knpkv/npm/commit/471974f89a86d01594cb9ac08d784ec1f4770541) Thanks [@konopkov](https://github.com/konopkov)! - Move both terminal applications from an OpenTUI preview build to the stable 0.5.1 release. Replace CodeCommit's flat pull-request detail page with an exact-head review workspace: complete changed-file inventory, lazy native diff previews, human decision state, preflighted prompt-only local Codex review actions, and deterministic detached worktree checkout. Add a prompt-only Codex transport mode for reviewing supplied untrusted text without host-capable tools or inherited instructions. Clear inherited repository-local Git variables, suppress configured hooks, and disable interactive authentication before Relay and worktree Git commands.

## 1.1.4

### Patch Changes

- [#343](https://github.com/knpkv/npm/pull/343) [`4def7db`](https://github.com/knpkv/npm/commit/4def7db2f400cf68218262994d67ed90a7154bf1) Thanks [@konopkov](https://github.com/konopkov)! - Align runtime ownership, cancellation, caching, time, failure handling, polling,
  decoding, and executable entrypoints with Effect v4 idioms. Expose clock-injected
  Atlassian token construction and expiry helpers, and enable workspace-wide
  Effect diagnostics and prevention checks.
- Updated dependencies [[`4def7db`](https://github.com/knpkv/npm/commit/4def7db2f400cf68218262994d67ed90a7154bf1), [`a9d5408`](https://github.com/knpkv/npm/commit/a9d54085f6fc25cde1d5b298f50cb6e06e2bc93f)]:
  - @knpkv/atlassian-common@1.3.0
  - @knpkv/jira-cli@1.2.3

## 1.1.3

### Patch Changes

- [#252](https://github.com/knpkv/npm/pull/252) [`6d510c9`](https://github.com/knpkv/npm/commit/6d510c9d3dab3e459db7fa1d25cd12f0e122699e) Thanks [@konopkov](https://github.com/konopkov)! - Update the generated Schema-backed Jira API client.

- Updated dependencies [[`521c44e`](https://github.com/knpkv/npm/commit/521c44e9b9d6f4adc3e5ba44f1d9f117698d4442), [`6d510c9`](https://github.com/knpkv/npm/commit/6d510c9d3dab3e459db7fa1d25cd12f0e122699e)]:
  - @knpkv/clockify-api-client@1.0.2
  - @knpkv/jira-api-client@1.0.1
  - @knpkv/jira-cli@1.2.2

## 1.1.2

### Patch Changes

- [#249](https://github.com/knpkv/npm/pull/249) [`5a61061`](https://github.com/knpkv/npm/commit/5a610619cef7609148b396d9248924422138221b) Thanks [@konopkov](https://github.com/konopkov)! - Fix `jcf` commands failing to decode Clockify time-entry responses when optional
  fields come back as explicit `null`:

  - `jcf timer start` failed with `Expected string, got null at ["kioskId"]` —
    Clockify returns `kioskId`, `projectId`, and `taskId` as `null` (not absent).
  - `jcf sync reconcile` failed with `Expected array, got null at [0]["tagIds"]` —
    Clockify returns `tagIds` as `null` for entries with no tags.

  Patch the OpenAPI spec so those fields decode as nullable across the time-entry
  response schemas (`TimeEntryDtoImplV1`, `TimeEntryDtoV1`,
  `TimeEntryWithRatesDtoV1`) and regenerate the client.

  Also stop `jcf timer start` from printing a misleading `Timer started` line
  after the start actually failed.

- Updated dependencies [[`5a61061`](https://github.com/knpkv/npm/commit/5a610619cef7609148b396d9248924422138221b)]:
  - @knpkv/clockify-api-client@1.0.1

## 1.1.1

### Patch Changes

- [#125](https://github.com/knpkv/npm/pull/125) [`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43) Thanks [@konopkov](https://github.com/konopkov)! - Replace the legacy Atlassian `openapi-fetch` clients with generated,
  Schema-validated Effect clients. Jira and Confluence now provide direct Effect
  operations, injected `HttpClient` transports, deterministic local regeneration,
  structural upstream freshness checks, and scheduled tested update pull requests.

  The legacy `toEffect`, `FetchClientError`, raw `.client` operation surface, and
  type-only generated subpaths are removed.

- [#125](https://github.com/knpkv/npm/pull/125) [`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43) Thanks [@konopkov](https://github.com/konopkov)! - Replace the openapi-fetch Clockify surface with a Schema-validated client generated by Effect's official OpenAPI generator. The old raw client, `ClockifyApiError`, `toEffect`, and `FetchClientError` exports are removed; consumers now use the generated `ClockifyApi` operations or the authenticated service conveniences.

- [#125](https://github.com/knpkv/npm/pull/125) [`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade the workspace to Effect 4.0.0-beta.98 and current compatible dependencies. Replace ad hoc object guards with Effect Predicate helpers and migrate retry schedules to the current Schedule API.

- Updated dependencies [[`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43), [`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43), [`665cecb`](https://github.com/knpkv/npm/commit/665cecbc3d5f79f9083acb1b393ace9a8ec0b1b8), [`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43), [`1bba5c2`](https://github.com/knpkv/npm/commit/1bba5c282684553fbc670e6dcf2960e8a4e200ed)]:
  - @knpkv/jira-api-client@1.0.0
  - @knpkv/jira-cli@1.2.1
  - @knpkv/clockify-api-client@1.0.0
  - @knpkv/atlassian-common@1.2.0
  - @knpkv/agent-skills@0.2.3

## 1.1.0

### Minor Changes

- [#117](https://github.com/knpkv/npm/pull/117) [`3d2e60f`](https://github.com/knpkv/npm/commit/3d2e60fd7d54852c9345a8577a411c82511e2fd3) Thanks [@konopkov](https://github.com/konopkov)! - Add End Correction to `jcf timer stop` — for when you forget to stop a running timer.

  - Stopping a running timer now always confirms the end first (`Started HH:MM · ends now HH:MM (…)`), defaulting to now on Enter.
  - Declining the confirm prompts for the real end as `HH:MM` (today) or a full ISO timestamp; a bare `HH:MM` that lands in the future rolls back to yesterday (the overnight "forgot to stop" case).
  - Add `jcf timer stop --at <HH:MM|ISO>` to set the corrected end non-interactively (skips the confirm).
  - The corrected end is validated (`start < end <= now`) and re-prompted on failure — never clamped, so a bad value can't silently log the full forgotten duration. The Clockify entry and Jira worklog both use the corrected end.
  - The TUI stop flow gains the same confirm/edit step before the comment popup.

### Patch Changes

- [#118](https://github.com/knpkv/npm/pull/118) [`da19038`](https://github.com/knpkv/npm/commit/da19038c59ade8e0b553874c02ad6017a0ed5d26) Thanks [@konopkov](https://github.com/konopkov)! - Fix the TUI stop confirmation popup: action buttons stacked vertically and overflowed the dialog box because the button row lacked `flexDirection: "row"`. Multiple buttons (e.g. "Edit end" + "Keep now", or "Retry" + "OK") now sit side by side inside the box.

- [#119](https://github.com/knpkv/npm/pull/119) [`468c3a2`](https://github.com/knpkv/npm/commit/468c3a2e84677d70cd887e343fd0f70059c3b2e0) Thanks [@konopkov](https://github.com/konopkov)! - Center the title and message lines in the TUI popup dialog (`PopupMessage`) so all content — title, lines, and action buttons — is horizontally centered, instead of the title/lines being left-aligned while the buttons were centered.

- [#120](https://github.com/knpkv/npm/pull/120) [`408828e`](https://github.com/knpkv/npm/commit/408828e252c3765758e64794848c48fb98f4e004) Thanks [@konopkov](https://github.com/konopkov)! - Fix the TUI big-timer view rendering left-of-center: `useTerminalSize()` was hardcoded to 80 columns, so the ticket, digits, progress bar, and controls were centered within the leftmost 80 columns instead of the full terminal width. It now reads the live terminal width (via `useTerminalDimensions`), so the timer centers correctly and tracks resizes.

- Updated dependencies [[`904d3d7`](https://github.com/knpkv/npm/commit/904d3d75948d94558484094cf225b5ea6585663e)]:
  - @knpkv/atlassian-common@1.1.0
  - @knpkv/jira-api-client@0.4.0
  - @knpkv/jira-cli@1.2.0

## 1.0.2

### Patch Changes

- Updated dependencies [[`734f891`](https://github.com/knpkv/npm/commit/734f8911d930cedc8642d5e2bd9fa73c76a99054)]:
  - @knpkv/atlassian-common@1.0.0
  - @knpkv/jira-cli@1.1.1

## 1.0.1

### Patch Changes

- [#103](https://github.com/knpkv/npm/pull/103) [`477e4c6`](https://github.com/knpkv/npm/commit/477e4c60fa5c501883be6c03629da5a3cc91444c) Thanks [@konopkov](https://github.com/konopkov)! - Add shared Atlassian auth profile storage for multi-account and multi-site OAuth use.

  Jira and Confluence now expose `auth profiles`, `auth use <profile>`, and `auth remove <profile>` commands backed by shared profile management in `@knpkv/atlassian-common`. Confluence also migrates existing legacy auth/config files on first use. Agent skills and docs now describe the profile commands and active-profile checks.

- [#105](https://github.com/knpkv/npm/pull/105) [`a3a4d3a`](https://github.com/knpkv/npm/commit/a3a4d3a14fafe235bc901ed5015bb9bd82c59281) Thanks [@konopkov](https://github.com/konopkov)! - Add a unified Atlassian profile manager CLI with cross-tool profile listing, selection, diagnostics, token refresh, and scope validation helpers.

  Update bundled Jira, Confluence, and Jira Clockify agent skills to recommend the unified profile diagnostics workflow.

- Updated dependencies [[`477e4c6`](https://github.com/knpkv/npm/commit/477e4c60fa5c501883be6c03629da5a3cc91444c), [`a3a4d3a`](https://github.com/knpkv/npm/commit/a3a4d3a14fafe235bc901ed5015bb9bd82c59281)]:
  - @knpkv/atlassian-common@0.4.0
  - @knpkv/jira-cli@1.1.0
  - @knpkv/agent-skills@0.2.2

## 1.0.0

### Major Changes

- [#99](https://github.com/knpkv/npm/pull/99) [`59478b0`](https://github.com/knpkv/npm/commit/59478b0d059d359feaf38222e5e55f748ee389d7) Thanks [@konopkov](https://github.com/konopkov)! - Refactor CLI command surfaces around resource-first groups and remove the legacy top-level aliases.

  - Jira issue reads now live under `jira issue get` and `jira issue search`; version reads and writes use `jira version get`, `jira version update`, and `jira version related-work`.
  - Confluence workspace setup now uses `confluence workspace clone`, page operations use `confluence page`, and sync/git-backed operations use `confluence sync`.
  - JCF timer operations now use `jcf timer`, ticket listing uses `jcf issue list`, and reconciliation uses `jcf sync reconcile`.
  - Agent skills and product-local skill copies now document the same canonical commands.

### Minor Changes

- [#94](https://github.com/knpkv/npm/pull/94) [`a12490d`](https://github.com/knpkv/npm/commit/a12490d423b1d4f4e1e75fee0e34093380b5389a) Thanks [@konopkov](https://github.com/konopkov)! - Add `jcf reconcile` to compare Clockify time against Jira worklogs over a period and fill the gaps. Work is bucketed per ticket per local day and summed on each side, so entries split across either system don't read as discrepancies. Pick a direction — `clockify-to-jira` (default) or `jira-to-clockify` — to choose which side is the source of truth; the command reports every bucket with its delta, then prompts to apply each missing slice into the under-logged side (it only ever adds, never deletes, and posts the delta so re-runs converge). Period flags: `--day` (default), `--week` (last 7 days), or a custom `--since`/`--until` window.

- [#92](https://github.com/knpkv/npm/pull/92) [`ceb4006`](https://github.com/knpkv/npm/commit/ceb4006fbae04f99219bacc23022c3143ecb4fd5) Thanks [@konopkov](https://github.com/konopkov)! - Surface _why_ a Jira worklog failed and stop offering pointless retries. The worklog post now reports a typed outcome (`Posted` / `NotLoggedIn` / `Failed{message}`) instead of a bare boolean, so:

  - the `jcf stop` CLI and the TUI retry popup show the actual failure reason (HTTP status / Jira error message) instead of a bare `✗`;
  - a not-logged-in failure is recognised as unrecoverable — the CLI/TUI show the `jcf auth jira login` hint and suppress the retry affordance rather than looping on a request that can never succeed;
  - a transient failure still offers retry, now labelled with the reason.

  Also guards the TUI Retry action against a double-keypress that could double-log the worklog.

### Patch Changes

- [#95](https://github.com/knpkv/npm/pull/95) [`53f260b`](https://github.com/knpkv/npm/commit/53f260bb01dc810af7926ab862f75590e766a531) Thanks [@konopkov](https://github.com/konopkov)! - `jcf reconcile` (clockify→jira) now uses the Clockify entry's own description as the Jira worklog comment instead of a fixed "Reconciled from Clockify". For a bucket spanning several entries the descriptions are ticket-prefix-stripped, deduped, and joined; it only falls back to the generic note when there's nothing meaningful to carry over.

- [#96](https://github.com/knpkv/npm/pull/96) [`8f1ff75`](https://github.com/knpkv/npm/commit/8f1ff75cdb5ef74bd4967f1c99c2e7877a844eed) Thanks [@konopkov](https://github.com/konopkov)! - Fix Jira worklog posts failing with a transport error in the TUI. The TUI runs under Bun, where the undici-based HTTP client (used by the raw Jira worklog POST) fails; the CLI runs under Node and was unaffected. Switch the shared HTTP client to the fetch implementation, which works in both Bun and Node — the same fetch the Jira/Clockify API clients already use.

- Updated dependencies [[`0eec900`](https://github.com/knpkv/npm/commit/0eec9001c32e70493be985449798d731f7dfb9ba), [`fdfd789`](https://github.com/knpkv/npm/commit/fdfd7897442a4616087463c60ae54d94f1726dd3), [`59478b0`](https://github.com/knpkv/npm/commit/59478b0d059d359feaf38222e5e55f748ee389d7)]:
  - @knpkv/jira-cli@1.0.0
  - @knpkv/agent-skills@0.2.1

## 0.5.0

### Minor Changes

- [#89](https://github.com/knpkv/npm/pull/89) [`7ee4f6d`](https://github.com/knpkv/npm/commit/7ee4f6d790ad24f2e52482fd29f223f702167e45) Thanks [@konopkov](https://github.com/konopkov)! - Let users retry a failed Jira worklog after a partial timer stop (Clockify saved, Jira failed) — via a "Retry" action in the TUI result popup and a retry prompt in the `jcf stop` CLI flow. Also fix `jcf start/stop/log <KEY>` reporting "Ticket not found in Jira" when actually not logged in: these now detect the missing Jira login and point to `jcf auth jira login`.

## 0.4.0

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

- [#88](https://github.com/knpkv/npm/pull/88) [`a245d53`](https://github.com/knpkv/npm/commit/a245d534f3946c0b3d8b0a0380dbd702d9f2982d) Thanks [@konopkov](https://github.com/konopkov)! - Fix the TUIs hanging after quit. On a clean in-app quit the main fiber exits with code 0, and because OpenTUI keeps stdin in raw mode (so Ctrl-C arrives as a keypress, not a SIGINT) `runMain`'s default teardown never called `process.exit`. The atom runtime kept the event loop alive (SQLite repos, HTTP client, EventsHub PubSub), so the process hung after the UI had already torn down. Both bins now pass a teardown that always terminates the host process.

- Updated dependencies [[`c697d3c`](https://github.com/knpkv/npm/commit/c697d3c4ab779f14f017d3ec8fc8d1bffa1493b5), [`19c1538`](https://github.com/knpkv/npm/commit/19c153835bc198b9e407a013c16775c3fb7eb357), [`e3c3805`](https://github.com/knpkv/npm/commit/e3c3805ee527a6edb69ed91977c95c586b563ff9)]:
  - @knpkv/agent-skills@0.2.0
  - @knpkv/jira-cli@0.3.0
  - @knpkv/atlassian-common@0.3.0
  - @knpkv/clockify-api-client@0.3.0
  - @knpkv/jira-api-client@0.3.0

## 0.3.0

### Minor Changes

- [#69](https://github.com/knpkv/npm/pull/69) [`ebe2800`](https://github.com/knpkv/npm/commit/ebe280079863e7236de20bf06c0db6446215dab1) Thanks @konopkov! - Add ways to log time when the timer was never started.
  - `jcf start KEY --ago <duration>` / `--since <HH:MM|ISO>` backdates the timer
    start to correct a forgotten start.
  - `jcf stop` with no running timer now offers to add a **correction interval**:
    pick a ticket, enter a duration and start time, and it writes a completed
    Clockify entry plus the matching Jira worklog.
  - `jcf log` gains `--at HH:MM` to set the start time (was hardcoded to 09:00) and
    now resolves project/billable/tags like `start` does.

  Internally, the Clockify-entry + Jira-worklog write path is shared via a new
  `TimerService.logManual`, and the per-command Jira issue fetch is centralised in
  `fetchTicketByKey`.

### Patch Changes

- Updated dependencies [[`ebe2800`](https://github.com/knpkv/npm/commit/ebe280079863e7236de20bf06c0db6446215dab1)]:
  - @knpkv/jira-cli@0.2.0

## 0.2.0

### Minor Changes

- [#61](https://github.com/knpkv/npm/pull/61) [`fc7be8f`](https://github.com/knpkv/npm/commit/fc7be8ffaf5b6b094c7f81551e8ace6f2a8f2c4c) Thanks @konopkov! - feat: add jira-api-client and atlassian-common packages
  - New @knpkv/atlassian-common: shared AST types, serializers, auth, and config
  - New @knpkv/jira-api-client: Effect-based Jira REST API client (openapi-gen)
  - Updated @knpkv/confluence-api-client: regenerated with openapi-gen
  - Updated @knpkv/confluence-to-markdown: use new generated API client

### Patch Changes

- Updated dependencies [[`fc7be8f`](https://github.com/knpkv/npm/commit/fc7be8ffaf5b6b094c7f81551e8ace6f2a8f2c4c)]:
  - @knpkv/atlassian-common@0.2.0
  - @knpkv/jira-api-client@0.2.0
  - @knpkv/clockify-api-client@0.2.0
  - @knpkv/jira-cli@0.1.1
