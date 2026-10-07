# @knpkv/jcf-web

## 0.6.0

### Minor Changes

- [#526](https://github.com/knpkv/npm/pull/526) [`6f39f65`](https://github.com/knpkv/npm/commit/6f39f658230a1fa069ea763fb05780fdab530ed8) Thanks [@konopkov](https://github.com/konopkov)! - The week page reads as one tool. The header names the product, says when the week was last read and offers the rly theme menu. Toolbar controls stay in groups that wrap together, so no button sits alone on a row or breaks its label. The week, its totals and its layer toggles share one bordered region. Saved time is named in words, with no coloured side stripes. The side column says what to do when nothing is open. A failed read or write appears inside the open editor instead of covering the page header. Dates and hours meet 4.5:1 contrast. The quick-approve control is 32px. Labels use commas instead of middots.

### Patch Changes

- Updated dependencies [[`c93baf2`](https://github.com/knpkv/npm/commit/c93baf29bba9d67ffc4938ce0b0ada533260fddc)]:
  - @knpkv/rly@0.10.0

## 0.5.0

### Minor Changes

- [#483](https://github.com/knpkv/npm/pull/483) [`da0e5ff`](https://github.com/knpkv/npm/commit/da0e5ff70ec5926beaeceff060a37b2b0f27b6f9) Thanks [@konopkov](https://github.com/konopkov)! - Discover every worked ticket from Claude Code and Codex sessions.

  Presence is now a supervised turn: a typed prompt, including one queued while the agent was busy, opens a turn and the agent's work inside it counts until the turn ends, a task notification or auto-continuation takes over, or the idle cap passes. Task notifications, auto-continuations and `isMeta` lines no longer count as typed. Legacy Codex tool-call response items keep a turn alive. `decodeTranscript` now requires `idleCapMs`; `decodeSessionLines` and `SessionLine` are new.

  Parallel stretches no longer drop tickets: every attributed ticket keeps a share, overlapping short tickets stay co-owners, and the web calendar shows suggestions down to Jira's one-minute minimum. When minutes are scarce, open-sprint tickets assigned to you rank first, then tickets not yet logged that day; the same facts appear as tie-breakers in the attribution prompt. Inside one unbroken stretch each ticket now gets a single block, ordered by first activity and packed with no gaps; a ticket that cannot reach a minute folds into the one ranked above it.

  Ignore a ticket in every week with `jcf config set session-ignore <KEY>` or the web's Ignore button, and restore it from the Ignored tickets list. An ignored ticket is never suggested or offered to the attribution agent; a branch or path match to it falls through to the session's other candidates, and its parallel time goes to the tickets it ran alongside. Reports carry its raw time as `ignored`. In the web calendar, back-to-back short suggestions show as one card per stretch, and the page uses the full window width.

  An orchestrating session nothing else places is split across the open-sprint tickets it mentions, by mention count, per active stretch (new attribution signal `split`); deterministic reads such as `jcf watch` leave it unplaced. The web lists low-confidence matches with a "Log as" action, and saved entries can be deleted or moved to another ticket; a delete releases its session claim so the time is suggested again, and a move carries the claim to the replacement. `SavedEntries` gains `remove` and an optional `ticketKey` on update.

  Quick approvals are confirmed in batches of up to fifty under one provider re-read (new `/api/rows/confirm-batch`), Jira worklogs are read eight issues at a time, and idempotent Jira reads retry a dropped connection twice, so a long queue no longer waits on one full re-read per approval.

  A provider window that needs manual review no longer fails a read: proposals carry a per-provider `writeBlocked` hold, the web shows the hold and disables writes to held providers, and writes keep refusing.

  Ticket moves persist a replacement intent before creating provider time. Uncertain or partial moves stay held across restart and cannot create another replacement on retry; a verified pair can be resolved by explicitly deleting either entry. Ordinary replacements retain their verified ID and start so extending a reviewed window does not mistake the move for unknown earlier time. The private source ledger upgrades to version 5 while retaining existing claims and holds.

  Breaking (`@knpkv/clockify-api-client`): `TimeEntryWithRatesDtoV1.costRate` and `hourlyRate` are now `RateDtoV1 | null`, matching the live API, which returns `null` when no rate applies.

### Patch Changes

- [#511](https://github.com/knpkv/npm/pull/511) [`02308ab`](https://github.com/knpkv/npm/commit/02308ab1fba5cda21939057ccefdbdd6875031bc) Thanks [@konopkov](https://github.com/konopkov)! - A work-description suggestion that arrives while you are already in the note field now lands selected, so your first keystroke replaces it instead of being appended to it.

- [#493](https://github.com/knpkv/npm/pull/493) [`e45eba3`](https://github.com/knpkv/npm/commit/e45eba30991dc662b7a8b09506d2d85b878fec97) Thanks [@konopkov](https://github.com/konopkov)! - `@knpkv/browser-pairing/owner-session` adds `serveWithBootstrapUrl(server, onReady)`. It runs a server layer, waits until it is listening, hands its bootstrap URL to `onReady`, and keeps serving. A launch that fails before it is listening fails without announcing a URL, and a failing `onReady` stops the server. `agent-usage serve`, `jcf-web` and `codecommit-web` now start their servers through it instead of three copies of that code. `@knpkv/codecommit-web` also exports `serveCodeCommit(options)` (`hostname`, `port`, `onReady`), the start sequence its own entry uses.
- Updated dependencies [[`28c22ae`](https://github.com/knpkv/npm/commit/28c22ae49825b06472c0d35aa9d7ef92ed5748ff), [`da0e5ff`](https://github.com/knpkv/npm/commit/da0e5ff70ec5926beaeceff060a37b2b0f27b6f9), [`934843b`](https://github.com/knpkv/npm/commit/934843bbcea57cbf3266fce950c020733046cac1), [`148daa6`](https://github.com/knpkv/npm/commit/148daa6be147dca74bc642bd552b603deb760eae), [`4e8f346`](https://github.com/knpkv/npm/commit/4e8f346b926b859ea2b3be07ec7dc6cb77ca8e76), [`e57bb6d`](https://github.com/knpkv/npm/commit/e57bb6db1b393dbff8e116573cf2db23992c1cf4), [`7df3dbb`](https://github.com/knpkv/npm/commit/7df3dbb9875ab31f369351df2de898b36d40e613), [`8924289`](https://github.com/knpkv/npm/commit/89242895271072b83185d6cc02376b2c56830f6a), [`f8d2612`](https://github.com/knpkv/npm/commit/f8d2612e09b20974dd8eccc8ff197bb072c40cbf), [`e45eba3`](https://github.com/knpkv/npm/commit/e45eba30991dc662b7a8b09506d2d85b878fec97)]:
  - @knpkv/jira-clockify@1.5.0
  - @knpkv/rly@0.9.0
  - @knpkv/browser-pairing@0.4.0

## 0.4.2

### Patch Changes

- Updated dependencies [[`487f2ba`](https://github.com/knpkv/npm/commit/487f2ba4fdb585f0cd0b2ab96fd4eeedce9da10d)]:
  - @knpkv/rly@0.8.0

## 0.4.1

### Patch Changes

- Updated dependencies [[`d5ee299`](https://github.com/knpkv/npm/commit/d5ee299ce3fa5584f2f54051009828af4a26fe4b)]:
  - @knpkv/rly@0.7.0

## 0.4.0

### Minor Changes

- [#468](https://github.com/knpkv/npm/pull/468) [`0fef7fb`](https://github.com/knpkv/npm/commit/0fef7fb84162380cf1f713ed40e98a5ccbdde804) Thanks [@konopkov](https://github.com/konopkov)! - Serve the built client with Effect's `HttpStaticServer` instead of three hand-rolled routers. jcf-web and agent-usage export `staticClient(root)` from `server/HttpApplication.js` in place of `isWithinDirectory`; jcf-web also exports `apiApplication` and `StaticRouter`, the two halves `application` merges, so a host can give the static client its own FileSystem. Visible changes: responses carry `Cache-Control: no-cache` plus ETag/304 and byte-range support, content types include a charset, only extensionless HTML navigations fall back to `index.html` (a missing `*.js` or an index-less directory is now 404), and a malformed percent-encoded path is a 404 (previously 500 in jcf-web and codecommit-web, 400 in agent-usage). codecommit-web's traversal guard no longer accepts sibling directories that share the client directory's name prefix.

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
