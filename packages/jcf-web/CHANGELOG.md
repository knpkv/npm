# @knpkv/jcf-web

## 0.3.0

### Minor Changes

- [#466](https://github.com/knpkv/npm/pull/466) [`f93ed3f`](https://github.com/knpkv/npm/commit/f93ed3f800ff7633c58389b27d3d6e99ff553fd0) Thanks [@konopkov](https://github.com/konopkov)! - Use the shared `@knpkv/browser-pairing/owner-session`. The `OwnerSession` module now exports `makeOwnerSession` and `ownerSessionAuthLayer` (agent-usage also `mintBootstrapUrl`); the secrets contract, bootstrap router and loopback helpers come from the shared module, and `makeServer`'s `ready` resolves with the bootstrap URL.

  BEHAVIOUR: `JCF_WEB_PUBLIC_ORIGIN` / `AGENT_USAGE_PUBLIC_ORIGIN` with a path, query or fragment now fails at startup instead of being stripped.

### Patch Changes

- Updated dependencies [[`f93ed3f`](https://github.com/knpkv/npm/commit/f93ed3f800ff7633c58389b27d3d6e99ff553fd0)]:
  - @knpkv/browser-pairing@0.3.0

## 0.2.0

### Minor Changes

- [#452](https://github.com/knpkv/npm/pull/452) [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade to Effect 4.0.0 stable. `effect` and every `@effect/*` dependency or peer dependency now require `4.0.0`; imports move from the removed `effect/unstable/*` paths to `effect/*`.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Make the web week responsive with a mobile agenda, Rly fields and status panels,
  keyboard-accessible manual entries, and an editor beside the desktop calendar.

  Stream actual read stages, attribution counts and detailed status to the browser.
  Allow cancellation and replacement of reads without letting older results replace
  the selected week. Validate streamed responses before displaying their plans.

  Single-system weeks no longer show false disagreement warnings, and clicking logged
  time no longer opens a manual entry.

  Return the declared HTTP status for expired plans and rejected proposals instead
  of treating their union as a generic server error.

  After web writes, refresh only provider totals and running-timer exclusions using
  the retained session evidence. Release navigation after the write, preserve the
  remaining gap on partial writes, and retry totals without another attribution run.

  Stream visible agent activity and structured answer fragments during ticket
  matching, with bounded browser history and cancellation.

  Show each agent batch as a read-only conversation, with its supplied request above
  the streaming response. Keep both after loading and totals-only refreshes, including
  providers that return a final answer without partial text. Format complete JSON
  responses for reading and preserve partial text as it arrives.

  Show Jira and Clockify as independent calendar layers with separate saved and
  suggested totals. Keep both providers visible when they record the same interval;
  layer switches do not repeat week reads.

  Restore retained week/scope plans on reload and refresh provider totals. Only explicit
  Rescan sessions actions reread transcripts and run attribution. Keep six plans in
  server memory. When none is retained, show saved provider entries and allow manual
  logging without reading sessions; an explicit scan restores suggestions.
  Offer that scan directly from the missing-suggestions message.

  Preview writes immediately with Effect Atom and settle Jira and Clockify separately.
  Roll back failed entries and retain successful writes through a failed totals refresh.

  Retain unkeyed Clockify entries as calendar time and include them in totals.
  Separate suggestions into no-overlap and overlapping layers, checking time against
  only the selected provider layers. Preserve whole blocks when changing categories.

  Centralize review reads, optimistic settlement and freshness in an Effect
  Atom module with controlled transport tests. Project calendar layers and placements in
  one pure module, accounting for minimum drawn height and overnight weekend entries.

  Remove the unplaced-hours and weak-attribution sections from the web week view.
  Remove provider-behind labels from saved calendar and agenda entries.
  Align layer headings, buttons and captions even when labels wrap or a provider is hidden.
  Keep the editor scoped to the clicked block; remove the block checklist and whole-day selection.
  Hide suggestions below 15 minutes of credit, wall duration or selected-provider remaining
  time, including restored scans. Preserve short saved provider records and original block
  indexes. Prioritize ticket keys over source labels in narrow calendar cards.
  Suggest editable work descriptions when a block opens, using retained session evidence and
  the selected agent. Cache requests per row and settings, preserve edited or deliberately
  cleared drafts across block selection, and reject stale responses. Keep approval available
  while a description is pending; writes never trigger hidden description generation.

  Use selected provider layers as write targets too. Hidden Jira or Clockify layers
  cannot receive approval or manual writes, including from an already-open editor.

  Expose web controls for the session-agent provider, model and effort that save the
  choice without starting a scan, and stream visible activity from either provider.

  Add Quick approve mode with immediate queued slots and a five-second Undo window.
  Keep subsequent suggestions selectable while provider writes run serially, then
  refresh totals once the queue drains. Cancel unsent approvals on Undo or disposal;
  retain successful provider results and roll back failures. Recheck selected layers
  before dispatch so hiding a provider cannot send a queued write to it.

  Keep the visible calendar time fixed through optimistic saves, editor close and totals
  refresh. Reserve the desktop editor column, float compact save/refresh feedback, and
  keep the narrow-screen editor within 75% of the viewport. Restore keyboard focus without
  scrolling, including when a saved suggestion disappears.

  Add a separate + button to each calendar and agenda suggestion for immediate queued
  approval with the current provider layers, default note and five-second Undo. Keep
  ordinary card clicks unchanged and allow more + approvals during queued writes.
  Float the bounded queue without shifting the calendar; retain usable sibling action
  targets and collision spacing for short suggestions.

  Move scan progress, stage details and live and completed agent conversations into the calendar's right panel, with
  Close, Escape and a reopen action. Keep the narrow-screen conversation bounded and
  preserve the calendar position when opening or closing it.

  Show progress beside the work-description field while the agent prepares its text,
  keeping typing and approval available throughout.

  Use multiline work-description fields in both entry forms. Make No overlap, Overlap
  and All exclusive suggestion filters while keeping Jira and Clockify independently selectable.

  Open saved Jira and Clockify entries, including unkeyed Clockify time, in the editor.
  Update their exact whole-entry times and multiline descriptions with optimistic
  replacement and rollback. Retain successful changes and rebuild totals locally before
  refreshing provider data. Reject stale refreshes, scans, provider snapshots and browser
  drafts using opaque entry revisions; unchanged totals refreshes preserve valid drafts.
  Generate descriptions explicitly from individually overlapping retained session evidence,
  preserving ticket prefixes and edits made during generation.

  Keep empty-week scan actions beside the desktop calendar and below it on mobile.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Allocate overlapping ticket credit into sequential blocks with the configured dwell floor, selecting the strongest tickets when fewer blocks fit. Keep actual active duration, idle gaps and standalone short work without inventing time. Reserve unplaced shares before scheduling known tickets so changing shares cannot fragment the calendar into sub-minute blocks.

  Share proposed worklog selection, sizing and provider anchoring through one pure module so preview and confirmation cannot disagree.

  Return exact written segments for partial provider outcomes and retain a stable source-block identity
  when scheduling moves a block. JCF web uses those contracts to settle disjoint optimistic entries,
  prevent corrected-ticket blocks from reappearing after a restart, reopen time removed by a saved-entry
  duration edit or verified deletion, and share one machine writer guard with `jcf watch`. Corrected
  session writes now retain their private provider-entry-ID binding across description edits and source
  suffix removal; uncertain creates and unlinked earlier entries require manual recovery instead of an
  automatic repeat.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Three things a week view needed to be usable on a real week.

  **Write one block, not the whole day.** Clicking a proposable block on the calendar now offers that
  stretch — `20:52–21:32`, its own forty minutes — with the row's other blocks one tick away in the
  panel, and the amount following whatever is ticked. A confirmation names block _positions_ of a plan
  the server still holds, never times or durations, so nothing a browser sends can widen a write.

  The arithmetic that makes this safe is worth stating: a side is sized against the row's credit minus
  what it already holds, and the selection only says how much of that room to use now. Sizing against
  the selection instead would report "already logged" for the second block of any row whose first
  block is in — it would read the morning's entry as evidence that the afternoon had been written too.
  Written blocks are anchored to their own start, so accepting the evening stretch files it at 20:52
  rather than after everything else the day holds.

  **Issue titles, everywhere the key appears.** On the calendar block (last line, so a short block
  loses the title rather than the times), in the confirm panel, and in every lane. Null means Jira
  could not be asked, which is said out loud rather than shown as an untitled row.

  **Only your own tickets are offered.** Hours on a ticket Jira assigns to somebody else move to an
  _Assigned to somebody else_ lane: hours still visible, with the assignee, and an `It is mine` button
  that records the exception in `~/.jcf/config.json` so it holds next week too. Nothing is withheld
  when Jira could not answer, or on a Clockify-only week where Jira is out of scope entirely — the
  header says which of those happened.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - The week is a calendar. Hours down, days across, every block at the time it happened: logged entries
  solid, proposable time dashed, overlapping work side by side the way a calendar shows it. Clicking a
  dashed block confirms it; clicking empty space offers a manual entry at the time clicked. A table of
  day totals could say how much, but only this can say when — and when is what a person checks a
  proposal against.

  That needed the engine to stop discarding what it already reads. `compare` walked each Clockify
  entry's real interval and summed it away into day totals; `ReconcileRow.intervals` now carries those
  intervals, labelled with the system that reported them, alongside the totals that remain
  authoritative on how much.

  Reconciliation can now be about one system. `compare` and `proposeFromSessions` take `sides`, and a
  system that is out is not read, not proposed for, and not written to. That is stronger than skipping
  its write: a side nobody read holds an unknown amount, and treating unknown as zero would propose the
  whole day for it. In the browser it is a header choice — both, Jira only, Clockify only — remembered
  per browser, and a Jira-only week makes no Clockify request at all.

  Writes take `targets` to match, and `SideOutcome` gains `Skipped` so a system nobody asked about is
  distinguishable from one that owed nothing. The gap on a skipped side is left exactly as it was, so
  asking for Jira today and both tomorrow writes the Clockify half tomorrow.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - A week of Jira and Clockify time in a browser, with the gaps a Coding Agent's sessions evidence
  offered for confirmation one row at a time. Rows are Issue Keys, columns are the seven days of one
  ISO week, and each cell carries both what the two systems already hold and what is missing — a gap
  only means something next to the time logged around it, which is why `jcf sync reconcile --agent`
  grew a grid rather than a longer list.

  The engine is unchanged and unshared: `@knpkv/jira-clockify`'s own services, config, and write path,
  so a week read here and a reconcile in a terminal derive the same rows from the same evidence.

  A person may overrule the amount and the Issue Key, and nothing else. An amount above the credited
  evidence is refused with the ceiling named; time no session evidences is a manual entry that claims
  no evidence at all. An Issue Key override is re-tallied against the bucket it moves to before
  anything is written. Both overrides are named in the text that lands in both systems.

  Unplaced hours name the directories behind them, and one click turns a directory into a Standing
  Attribution — the repair that makes recurring ticket-less work an ordinary proposal from then on.

  Loopback only, with `@knpkv/codecommit-web`'s owner-session rules: a printed one-time URL, a session
  cookie, an origin check, and a CSRF token on every write.

### Patch Changes

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Serialize every provider write behind one machine writer guard (`WriterGuard`), shared by `jcf watch`, the CLI and the browser, with a typed refusal reason. Hold, rather than recreate, a bound Jira or Clockify entry whose absence the provider cannot prove, and check source and target again after reserving and before the final write. Bind direction-created entries only when the ledger verifies a single target, record Jira's creation time on new bindings (source ledger v4, migrated in place), and render calendar rows by elapsed minutes so DST days line up.
- Updated dependencies [[`adfad78`](https://github.com/knpkv/npm/commit/adfad78662f20b698a2c6d76a70e824c52e22029), [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e), [`b2d229d`](https://github.com/knpkv/npm/commit/b2d229d2208fb9e7f2d9dc174ff12d769c5b8225), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`8022091`](https://github.com/knpkv/npm/commit/802209142207593461eaef384d31757f746a2452), [`fa695f0`](https://github.com/knpkv/npm/commit/fa695f0179c67701e468fcedcd07c4b738c9734a), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`acb8b25`](https://github.com/knpkv/npm/commit/acb8b25772cc188a0cc1299a1b591903240cfc7c), [`08a1c42`](https://github.com/knpkv/npm/commit/08a1c42ba3e9c4505919477f8b601262fb07952e), [`6ce5d6a`](https://github.com/knpkv/npm/commit/6ce5d6a1919515b9701ba0f0ec78c01cb408b623), [`fecd5b0`](https://github.com/knpkv/npm/commit/fecd5b05e26df62f87ea0f66f226cefdb685cc59)]:
  - @knpkv/rly@0.6.0
  - @knpkv/browser-pairing@0.2.0
  - @knpkv/jira-clockify@1.4.0
