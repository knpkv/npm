# @knpkv/jira-clockify

## 1.4.0

### Minor Changes

- [#452](https://github.com/knpkv/npm/pull/452) [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade to Effect 4.0.0 stable. `effect` and every `@effect/*` dependency or peer dependency now require `4.0.0`; imports move from the removed `effect/unstable/*` paths to `effect/*`.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Add `jcf sync reconcile --agent claude`, which reads local Claude Code Agent Sessions as
  reconciliation evidence and proposes the Clockify entries and Jira worklogs neither side recorded.
  Each proposal carries the Attribution Signal that produced it, is sized per side to that side's own
  gap, and is selected in one checkbox picker. Time is derived from the messages the user typed — a
  Coding Agent's own output and its tool results are excluded, so an unattended run credits at most the
  Idle Cap rather than the hour it ran for. Presence between consecutive prompts is bounded by a
  configurable Idle Cap, and any instant worked in parallel is divided equally between the Issue Keys
  active in it — so a day's proposals can never exceed its wall clock, and parallel work is
  not awarded to whichever session happened to log an event first. A day with a Timer still running is
  reported and excluded. `--calendar` draws the intervals as an hour-by-hour ASCII grid.

  Every entry it writes says what the time went on. A Clockify description and a Jira worklog comment
  now carry the Jira issue title and one sentence, read off the session's own prompts by a Coding
  Agent, describing what was actually done — because the question asked of a timesheet line months
  later is _what_ the time went on, and by then the Issue Key is a lookup and the transcript is gone.
  The `[KEY]` prefix still leads the Clockify description, so a second run tallies exactly as before.
  Notes are asked for only about rows the user has confirmed, in one batched call, and the text is
  printed before it is written. A failed, timed-out or unavailable Coding Agent costs the sentence and
  never the write: the entry falls back to the title and its provenance, and a session whose prompts do
  not say what was done gets no sentence rather than an invented one.

  Everything needed to judge a proposal is on its row _in the picker_ — the day, when the work item
  started and ended, the Issue Key, what each side would gain, the Attribution Signal, the Jira issue
  summary, its assignee, what the sides already hold, and how many blocks the total spans. Nothing is
  listed above the picker, where it would already have scrolled past by the time there is a decision to
  make; only rows the picker cannot offer are reported there. Rows are laid out for the terminal's own
  width, spending a wider one on the issue title and the block times.

  Also fixes two reporting defects in the existing direction mode. Logger output now goes to stderr,
  so a single warning can no longer corrupt `--json` output. And a direction that finds nothing to add
  no longer claims the two sides are "in sync" when the _other_ side is short — it names the shortfall
  and the reverse command, because a direction only ever asks whether its target is short. Direction
  rows and their confirmations now carry the Jira issue summary and assignee as well as the key.

  Presence is counted narrowly and scope is enforced before anything is read. Only messages the user
  typed evidence presence — a Coding Agent's own output, its tool results, and the prompts it sends its
  own subagents all show it was busy rather than that anyone was working. A transcript outside every
  Session Root is never opened at all rather than read and then discarded: the Claude CLI names each
  project directory after the working directory it ran in, so scope is decided from the directory name.
  On the author's machine that is two directories opened instead of 157.

  Reading the recorded side is allowed to fail. Every proposal is `session − (already recorded)`, so an
  unread Jira worklog is indistinguishable from an absent one and would re-log hours Jira already
  holds. A failed worklog read fails the run instead: failing costs a run, guessing costs someone
  else's timesheet.

  Sessions needing a Coding Agent are attributed in batches rather than one call each, because a
  call's cost is almost entirely fixed overhead: measured against the real CLI, one session cost $0.080
  and seven together cost $0.049. Batches are bounded so a single timeout costs one call's sessions
  rather than the run.

  Adds `sessionRoots`, `sessionTicketMap`, `sessionIdleCapSeconds`, and `sessionConfidenceFloor`
  config with `jcf config set session-root`, `session-ticket`, and `idle-cap` subcommands.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Two additions, both about what a row is made of.

  **Every block carries its own credit.** `TicketDayCredit` and `SessionProposal` now expose `blocks`
  — the coalesced stretches behind a row, each with the seconds it contributes — in place of `spans`.
  They sum to the row's total exactly: the seconds that flooring drops go to the blocks with the
  largest fractional part, because a row whose parts do not add up to the whole it was offered under
  is a row nobody can check. Credit, not wall clock, so a block worked in parallel with another
  ticket is worth less than the interval it spans.

  That is what lets a surface offer one stretch at a time rather than a whole day, which is the shape
  a person actually reconciles in — the morning went on this ticket, the twenty minutes after lunch
  did not.

  **A new `IssueFacts` service says who owns a ticket, and what it is called.** One
  `key in (…)` search answers for a week, returning titles alongside assignees, cached in
  `~/.jcf/issues.json` for twelve hours.

  Ownership is asked of Jira because a branch cannot tell authoring from reviewing: checking out a
  colleague's pull request puts their Issue Key on the branch, and branch attribution then offers
  their ticket as your work. Ownership is decided by account id, never by display name, and the whole
  cache is discarded when the logged-in account changes — `mine` is a claim about one account, and
  another account's answer is wrong rather than merely stale.

  Every failure mode leaves a key _unknown_ rather than "not yours": no login, an unreachable site, an
  issue in a project you cannot see. A caller may act on Jira saying a ticket belongs to somebody
  else; acting on Jira not having been asked would hide hours that really happened.

  Configured by `jcf config set ownership assigned|any` (default `assigned`) and
  `jcf config set mine <ISSUE-KEY>` for your work on somebody else's ticket, both shown by
  `jcf config show`.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Scan Codex session history alongside Claude Code so recent Codex work can produce time suggestions.
  Include resumed rollouts stored in older date directories, stream away tool payloads, and apply
  session roots before ticket mining or agent disclosure. Count current and older human prompt
  events once; exclude injected context, replayed prompt copies and native subagent sessions.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Ownership of the timeline now changes no more often than the Dwell Floor — fifteen minutes by
  default, `jcf config set dwell <seconds>`, zero to turn it off.

  Three concurrent sessions on three Issue Keys interleave their prompts, and read literally that says
  the work changed ticket every few minutes. It did not: it is an artefact of reading several
  transcripts at once. A day of it is two dozen slivers on a calendar and indefensible on a timesheet.
  `applyDwellFloor` reassigns any stretch shorter than the floor to the neighbour it touches,
  preferring the incumbent — the ticket that was already holding that time before the interruption.

  It reassigns time and never creates or drops any, so the inequality that makes a proposal safe to
  accept survives intact. Three rules bound it:

  - A short stretch is **not** absorbed when that would turn hours nothing placed into hours credited
    to an Issue Key. Demoting an attributed sliver into unplaced time is safe — nothing gets written —
    but the reverse would bill work no transcript placed there.
  - A stretch with no neighbour keeps its own time, however brief. Four minutes alone in the evening
    has no incumbent to belong to, and dropping it would lose work that happened.
  - Nothing is ever welded across a local midnight, because runs are bucketed by the day they start
    in.

  The credited spans on a proposal now come from the same coalesced timeline as its seconds, so a
  row's blocks and its total can no longer tell different stories.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Expose the headless engine so a second surface can derive and write Proposed Worklogs. The package
  had no `main` and no `exports` at all: it was reachable only as the `jcf` binary. `.` is now a
  namespace barrel over the agent-session core, the services, the live layers, the write path, and the
  calendar — deliberately without the command definitions or the TUI — and
  `@knpkv/jira-clockify/testing.js` exports `makeFakeHeadless`, the seam that fakes every external
  boundary and captures every write.

  Writing a proposal reports instead of printing. `applyProposal` returned seconds and logged its own
  `✓`/`✗` lines through `Console`, which only a terminal can consume; it now returns a per-side
  `SideOutcome` and `writeOutcomeLines` renders it, so one set of words serves every surface. The
  distinction between a side that refused and a side that owed nothing is now in the type rather than
  in a zero.

  Adds `startOfIsoWeek` and `isoWeekPeriod`, both built from local calendar fields, so a Monday-to-Sunday
  week stays a week across a daylight-saving change.

  A written entry now says what it claims about itself. `WriteProvenance` records three independent
  facts — whether a transcript stands behind the time, whether a person set the amount, whether a
  person chose the Issue Key — and the provenance text follows. A row where a person overruled the
  evidence must not keep citing it for the part they chose.

  The proposal report now carries `recorded`: what Clockify and Jira already hold over the period. A
  run reads both sides anyway to size its proposals, so a surface that shows allocated time beside
  proposable time no longer has to tally two remote services a second time.

  Unplaced hours now name the directories behind them. `UnattributedDayCredit.cwds` lists the distinct
  working directories of the sessions whose time no signal could place — the repair for unplaced hours
  is a Standing Attribution, and a Standing Attribution is a directory prefix, so "3h40m
  unattributed" on its own told a reader nothing they could act on.

  `ticketSummaryReader` joins `fetchTicketByKey`: it resolves the Jira services once and returns a
  function that answers with a title or null, so a consumer can name what `[PROJ-1]` was about without
  importing a Jira client. The `NOT_LOGGED_IN_HINT` moved to a leaf module for the same reason — the
  write path now runs in a browser bundle, where an HTTP client and a keychain have no business being.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Add persisted session-agent settings for Claude or Codex, with optional model and effort validated by a public pure schema. Read the current settings for every attribution and description operation, so changing them needs no restart.

  Report the recorded-time stage from the reconciliation engine and read timer exclusions concurrently with recorded time. Accept an optional activity observer on `SessionAttributor.attribute` and forward visible agent text and process status tagged with batch number and count.

  Retain attributed credits on the session report, including credits with no current gap or withheld by a running timer, and add `refreshRecordedTime` to recalculate proposals from that evidence without rereading transcripts or calling the agent.

  Retain closed Clockify entries without a ticket key as read-only `unlinkedClockify` records; they never become Jira reconciliation candidates.

  Add `SavedEntries` to `Headless.layer` for whole-entry updates against a server-retained snapshot, rechecking provider ownership and the current snapshot and distinguishing validation, conflict and provider failures. Carry optional whole-entry metadata on recorded intervals, including exact original bounds and description. Optionally retain `sessionEvidence` with each session's ticket and active intervals, and accept a nullable ticket key on `SessionAttributor.describe` for unkeyed time.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Allocate overlapping ticket credit into sequential blocks with the configured dwell floor, selecting the strongest tickets when fewer blocks fit. Keep actual active duration, idle gaps and standalone short work without inventing time. Reserve unplaced shares before scheduling known tickets so changing shares cannot fragment the calendar into sub-minute blocks.

  Share proposed worklog selection, sizing and provider anchoring through one pure module so preview and confirmation cannot disagree.

  Return exact written segments for partial provider outcomes and retain a stable source-block identity
  when scheduling moves a block. JCF web uses those contracts to settle disjoint optimistic entries,
  prevent corrected-ticket blocks from reappearing after a restart, reopen time removed by a saved-entry
  duration edit or verified deletion, and share one machine writer guard with `jcf watch`. Corrected
  session writes now retain their private provider-entry-ID binding across description edits and source
  suffix removal; uncertain creates and unlinked earlier entries require manual recovery instead of an
  automatic repeat.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Add `jcf watch claude`, which logs Agent Session time as it happens instead of being asked for it
  afterwards. It derives the same Proposed Worklogs `jcf sync reconcile --agent` does, from the same
  evidence and the same arithmetic, and writes them without a picker — so the common case of a day
  spent on ticket branches needs no reconciliation at all.

  Unattended writing is bounded by three rules rather than by a person. A block of work is written no
  sooner than one Idle Cap after its last moment, because until then it can still grow and its share of
  parallel work can still change — the bound is exact, since a window that could still overlap a block
  must close within one Idle Cap of it. Only attributions somebody deliberately created are written: a
  branch name, a worktree path, a Standing Attribution. Time only a Coding Agent could place is named
  on screen and left for `reconcile`, where it is shown before it is written. And the window starts
  where the watch does, so the morning it was started in is never backfilled.

  A Coding Agent is woken only to describe a block being written, never to attribute one — a session's
  Issue Key does not change, so asking every five minutes would spend a call to be told the same thing.
  Written entries carry the issue title and that sentence exactly as a confirmed `reconcile` row does.
  Nothing is remembered between looks, because a proposal is always `session − (already recorded)`: a
  failed write, a closed laptop, or a restart costs a delay rather than an hour, and a block already
  written produces no proposal at all. Jira rejecting the login stops the watch rather than logging to
  Clockify alone all afternoon and rebuilding the discrepancy the tool exists to close. `--dry-run`
  prints what would be written; `--interval` sets how often it looks, defaulting to five minutes.

  The closing summary counts only what each side actually took, so a refused Clockify entry or a
  rejected Jira worklog is never reported as time written — for a command whose purpose is making sure
  hours are not lost, overstating what it wrote is the wrong direction to be wrong in. Under
  `--dry-run` an unchanged row is described once rather than on every look, since a dry run writes
  nothing and would otherwise re-describe the same settled row until it was stopped.

  Also fixes a running-Timer exclusion that was one day wide. A Timer left running hides its time from
  the Clockify tally on _every_ local day it spans, but only the day it started on was withheld from
  proposals, so a longer window could propose hours that would be logged a second time the moment the
  Timer stopped.

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

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Serialize every provider write behind one machine writer guard (`WriterGuard`), shared by `jcf watch`, the CLI and the browser, with a typed refusal reason. Hold, rather than recreate, a bound Jira or Clockify entry whose absence the provider cannot prove, and check source and target again after reserving and before the final write. Bind direction-created entries only when the ledger verifies a single target, record Jira's creation time on new bindings (source ledger v4, migrated in place), and render calendar rows by elapsed minutes so DST days line up.

### Patch Changes

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Replace internal project names, keys and work descriptions in fixtures, examples and documentation
  with neutral placeholders. Nothing about behaviour changes; these are the strings a reader of a
  public package would otherwise see.

  `ClockifyApiClient`'s tests now compose their client once through `it.layer`, with each case
  declaring the response it wants, instead of providing a layer inside every test body.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Draw `--calendar` by the local clock rather than by distance from midnight. The two differ on a
  daylight-saving day: after a spring-forward, work at 03:00 sat two hours from midnight and was drawn
  in the `02h` row, and after a fall-back every later block shifted by an hour so the last of them ran
  off the end of the grid and vanished — precisely when the grid is being used to judge whether a
  proposal is right.

  Also states what the transcript pre-read filter can actually guarantee. Scope is decided from the
  project directory's name, and that name is a lossy encoding of the working directory, so a root
  `/a/b-c` and an out-of-root `/a/b/c` collide. A colliding transcript is opened and then discarded
  unread; every other out-of-scope transcript — 155 of 157 on the author's machine — is never opened.
  The module claimed the stronger thing.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - `jcf config reset` now also clears the session settings it displays. `jcf config show` lists the
  Session Roots, Standing Attributions and Idle Cap, so leaving them untouched was invisible: a user
  chasing a bad Idle Cap would reset, see it still there, and have nothing to go on.

  A hand-edited `~/.jcf/config.json` is also held to the bounds the `jcf config set` subcommands
  already enforce. An Idle Cap of `0` made every presence window zero-length, so nothing was ever
  proposed again; a confidence floor above `1` — `70` for "70%" is the obvious slip — withheld every
  Coding Agent attribution permanently. Both now fall back to the default instead.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Stop treating an unreadable Jira worklog as an absent one. `jcf sync reconcile` fetches each issue's
  worklogs to work out what Jira already holds, and turned any per-issue failure into an empty list —
  so one transient Jira error made a bucket look short and offered to fill it, posting hours that were
  already there. The read now fails the run and names the issue it failed on.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Read every page of Jira's worklog search. `jcf sync reconcile` asked for the first hundred issues and
  ignored the continuation token, so in a window with more than that, a ticket that fell off page one
  tallied as holding no Jira time at all — and since every caller subtracts this from what a session
  accounts for, that reads as "Jira is short by the whole day". `jcf watch` would then post hours Jira
  already had. A week with a hundred issues is ordinary. The read now follows the token, and fails the
  run rather than proceeding on a partial tally.

  Win the watch lease by creating the file, not by reading it. A read-then-write let two watches
  starting together both conclude the lease was free; acquisition is now an exclusive create, so the
  filesystem picks the winner. An existing lease is never overwritten based on elapsed time: stale
  takeover is another read-then-write race. An ungraceful death leaves a lock for explicit cleanup.

  Resume from the earliest _unresolved_ instant rather than from the shutdown time. A watch stopped
  mid-block was holding prompts that had not settled; recording when it stopped and resuming from there
  filtered out exactly those prompts, so the block it was protecting was lost anyway. The cursor now
  records the oldest block still held.

  And a resume no longer authorises back-dating. Taking `max(cursor, now − settleWindow)` meant any old
  cursor resolved to `now − settleWindow`, so every restart wrote a fresh window of unreviewed work —
  the forward-only boundary held only for the very first run. The lease decides whether a resume is
  offered at all, and only when the previous holder stopped recently.

  `jcf watch` also pointed at `jcf auth login` when Jira refused a worklog. That command does not
  exist; the real one is `jcf auth jira login`, so following the instruction produced another error.

  The `--agent` picker's header is bounded to the terminal width like its detail line already was. A
  long Issue Key with unequal gaps passed eighty columns, and since the prompt counts only the title
  lines it was handed, the terminal wrapped the surplus and every later row sat a line out of place
  while the user was choosing what to write.

  The `no-cli-runmain-default-error-reporting` rule now matches the options argument rather than
  anything inside the call, so `runMain(makeProgram({ disableErrorReporting: true }), { teardown })` —
  where reporting is still on — is caught.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - `parseDuration` now reads back everything `formatDuration` writes: spaces between the parts, and a
  trailing seconds component (`1h 30m`, `56m 36s`, `30s`).

  The two had drifted into disagreement, and the place it showed was a form. A credited amount of
  3396 seconds renders as `56m 36s`, which the parser rejected — so any row whose credit was not a
  whole number of minutes arrived pre-filled with text its own validator refused, and could not be
  accepted at all. Units still have to appear in order, so `1h30` and `30s 5m` stay malformed.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Start a Codex turn's timeout after prompt-only feature discovery, so a slow `codex features list` no longer eats into the turn's budget. JCF now reads Issue Keys from textual tool results as attribution evidence (never as presence), and agent reconcile no longer says both sides hold everything while withheld, unattributed or skipped time is still listed. Session Root and Standing Attribution prefixes now accept `~` only as `~` or `~/…`, `jcf watch` names unplaced time again when a later session or another half hour adds to the same day, and `jcf timer edit` exits non-zero when a guarded edit is refused.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Stop `--agent` mode from writing hours that already exist, and stop `jcf watch` from losing hours it
  half-wrote. Five defects, all in the same direction: something the recorded side actually held was
  invisible to the subtraction, so the gap looked bigger than it was.

  - **The Clockify tally read one page.** It asked for no page size, so it got Clockify's default of 50. On any busy week the entries past that read as time Clockify never had. Now paged until a page
    comes back empty — a short page is not the last one, since the server may serve fewer than asked —
    and a run that would exceed the page bound fails rather than acting on a partial tally.
  - **An entry crossing midnight counted entirely against the day it started.** Session credits are
    split at each local midnight, so a 23:30–00:30 entry left the following day looking untouched.
    Recorded intervals are now split the same way.
  - **The watch's resume cursor moved before the write.** It advanced past every settled block, then
    looked up tickets, generated descriptions and wrote. A Jira refusal after Clockify had succeeded
    therefore persisted a cursor past a row whose Jira half was missing, so the restart the command
    asks the user to perform skipped it. `--dry-run` had the same shape without the failure: it wrote
    nothing and still resolved everything. A block now stays behind the cursor until both sides that
    were short have taken it.
  - **The Jira worklog search treated a page with no `issues` as an empty one.** The generated schema
    makes the field optional, so a truncated or changed response read as "this user logged no work".
    Both that and an issue with no readable key now fail closed.
  - **`--day` and `--week` were an hour out on daylight-saving transitions.** The endpoint was a local
    midnight plus 24 elapsed hours, which on a 23- or 25-hour day is not the next midnight. Both ends
    are now anchored to a real local midnight.

  Also: `jcf watch` refuses to start when the lease cannot be written at all, rather than treating an
  unwritable config directory as evidence that another watch holds it and running unprotected; each
  lease is signed and immutable while held, so no read-then-overwrite stale takeover can admit two
  writers; an in-scope transcript that cannot be read fails
  the run instead of being skipped, because omitting it hands its share of an overlapping interval to
  whichever session happened to be readable; issue keys delimited by underscores — `feature_PROJ-42_work`
  — are now recognised, where `\b` had matched nothing and left the session unattributed and so
  unlogged; and entries created by `--agent` carry the configured billable default, which `jcf timer
start` already sent.

  The daylight-saving tests for the calendar grid were passing on ordinary 24-hour days: the suite ran
  in whatever zone the machine had, and the dates they pin are US transitions. It now runs in a fixed
  zone, and both tests fail with the old arithmetic restored.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Credit the Idle Cap after a session's _final_ prompt, not only after prompts that happen to be
  followed by another. The gap was load-bearing rather than cosmetic: a final prompt contributed
  nothing until some later prompt arrived, and then a window appeared **retroactively** — one that
  could overlap a block `jcf watch` had already settled and written, halving that block's share after
  the fact while the new share was written too. Two Issue Keys then held more time between them than
  the clock has. Materialising the window as soon as the prompt is seen is what makes "settled" mean
  settled: every window a prompt will ever produce now exists the moment the prompt does.

  A day therefore credits up to one Idle Cap more per session than before, which is the behaviour
  ADR-0006 already described — "the most time credited after a final prompt".

  Attribute each stretch of a session to the branch it actually ran under. A transcript is now read as
  one segment per `(working directory, branch)`: taking the last line's branch for the whole file
  credited the morning's prompts to the afternoon's ticket, and under `jcf watch` the morning could
  already have been written under the first ticket and then derived again under the second — the same
  wall clock on two tickets. Segments that resolve to the same Issue Key are unioned again, so a branch
  change that does not change the work costs nothing.

  Refuse a Standing Attribution that is not an Issue Key, in the config file and in `jcf config set
session-ticket`. An empty one wrote a Clockify description of `[] …`, which the tally then declines
  to read back — so a watch never saw the entry it had just made and wrote the same time again on every
  settled tick, without end.

  Fail rather than guess when the running-timer check cannot be answered. `detectRunning` turned an
  unreachable Clockify into "nothing is running", which is the opposite answer: a running entry has no
  end and is invisible to every tally, so proposing that day logs those hours twice the moment the
  timer stops. It also now clears a stale running state once Clockify reports the timer gone, so a
  long-lived watch stops excluding a day forever after the timer was stopped from the web.

  Anchor an incremental write past the blocks the target side already holds, including the exhausted
  case, so a second write for a `(ticket, day)` cannot overlap the first.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Only one `jcf watch` writes at a time. Subtracting what Clockify and Jira already hold makes a
  _later_ look safe and says nothing about a _simultaneous_ one: two processes can derive the same gap
  before either writes it, and an accidental second terminal is enough to double a day. A watch now
  takes an immutable lease in the config directory; a second one says who has been running since when
  and stops. The lease is never overwritten based on elapsed time because that takeover is not atomic.
  An ungraceful death therefore requires manual lock removal after verifying no watch remains.

  Write a settled block when the command says it will. The block already ran one Idle Cap past its
  last prompt, and the deadline added another — so a block promised after six quiet minutes was
  withheld for eleven. The bound is still exact: a later prompt can only extend a block by landing
  within an Idle Cap of the last one, which is before the block's own end.

  A restart no longer drops the block it was holding, and a first run still reaches back for nothing.
  The lease carries how far its holder got, so a restart _resumes_ from that point — bounded by one
  settle window, the stretch that cannot have settled and so cannot have been written. A first-ever
  watch has no such record and therefore no reach at all, which keeps "covers only time since it
  started" exactly true rather than approximately. Work older than the resume point stays
  `jcf sync reconcile`'s, which shows the rows before writing them.

  End a stretch's presence where the next one begins. A session that switches branch gave its old
  stretch a full Idle Cap of tail, which ran into the new branch's work and was shared back onto the
  old Issue Key — so a switch a minute in put those minutes on both keys at once. The boundary line's
  text also belonged to the wrong side of the switch, and a stretch with no typed prompt leaked its
  text into the next one, which could carry evidence out of a directory that was never opted in.

- [#438](https://github.com/knpkv/npm/pull/438) [`acb8b25`](https://github.com/knpkv/npm/commit/acb8b25772cc188a0cc1299a1b591903240cfc7c) Thanks [@github-actions](https://github.com/apps/github-actions)! - Update the generated Schema-backed Jira API client.

  Breaking: these exported types now include `null`, so code that reads them must handle it: `ApprovalConfiguration`, `BoardFeaturesPayload`, `BoardsPayload`, `ConditionGroupConfiguration`, `ConditionGroupUpdate`, `CustomFieldPayload`, `FieldCapabilityPayload`, `FieldLayoutPayload`, `FieldLayoutSchemePayload`, `FieldSchemePayload`, `IssueLayoutPayload`, `IssueTypeHierarchyPayload`, `IssueTypePayload`, `IssueTypeProjectCreatePayload`, `IssueTypeScreenSchemePayload`, `NotificationSchemePayload`, `PermissionPayloadDTO`, `PreviewConditionGroupConfiguration`, `PreviewRuleConfiguration`, `ProjectId`, `RolesCapabilityPayload`, `ScopePayload`, `ScreenPayload`, `ScreenSchemePayload`, `SecuritySchemePayload`, `TargetClassification`, `TargetMandatoryFields`, `TargetStatus`, `WorkflowCapabilityPayload`, `WorkflowLayout`, `WorkflowProjectIdScope`, `WorkflowRuleConfiguration`, `WorkflowStatusLayout`, and `WorkflowTransitionLinks`. `ProjectId` and `WorkflowLayout` also appear in responses. No exports are removed; 129 are added.

- Updated dependencies [[`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e), [`e17fbbb`](https://github.com/knpkv/npm/commit/e17fbbb8760f5f8bcf9a73b7d2d11a526c37fadd), [`bd45f8c`](https://github.com/knpkv/npm/commit/bd45f8cdeb1e8301bfcde42254792a488734d7e5), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`acb8b25`](https://github.com/knpkv/npm/commit/acb8b25772cc188a0cc1299a1b591903240cfc7c), [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183)]:
  - @knpkv/ai-claude@0.4.0
  - @knpkv/jira-cli@1.4.0
  - @knpkv/clockify-api-client@2.0.0
  - @knpkv/ai-codex@0.5.0
  - @knpkv/atlassian-common@1.5.0
  - @knpkv/jira-api-client@2.0.0
  - @knpkv/agent-skills@0.3.2

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
