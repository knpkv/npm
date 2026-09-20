# @knpkv/jcf-web

A week of Jira and Clockify time in a browser, with the gaps a Coding Agent's sessions evidence
offered for confirmation one row at a time.

`jcf sync reconcile --agent claude` already derives those gaps and writes them from a terminal. This
is the same engine — `@knpkv/jira-clockify`, the same services against the same config — behind a
grid, because a gap only means something next to the time already logged around it, and a week is how
a timesheet is actually read.

## Running it

```bash
pnpm --filter @knpkv/jcf-web build   # the client is a static bundle the server serves
pnpm --filter @knpkv/jcf-web start   # prints the URL that gets you in
```

The printed URL carries a one-time code in its fragment. Opening it exchanges the code for a session
cookie and strips it from the address bar; reloading afterwards works because the cookie is what
authenticates. The code expires a minute after the server binds, so restart to get a fresh one.

For development, `pnpm --filter @knpkv/jcf-web dev` runs the server and Vite together and prints a
URL on the dev origin, which proxies the API and the bootstrap exchange so the browser stays on one
origin.

`PORT` moves the server (3111 by default).

## What the calendar shows

Hours down, days across, and every block at the time it actually happened — one ISO week, Monday
first, so a week is the same week every time you open it. Saturday and Sunday appear only when they
hold something. The visible hours are a working day, widened to cover anything outside it, because a
23:40 session is exactly what someone opens this to find.

Four independently switchable calendar layers:

- **Jira** shows every Jira worklog at its reported start and duration.
- **Clockify** shows every Clockify entry at its reported interval. Both provider layers remain
  visible when they hold the same time. Each block names its provider and uses its Rly service rail.
- **No overlap** shows suggestions outside saved time in the visible provider layers, selected by default.
- **Overlap** shows only suggestions intersecting those entries.
- **All** shows both. These three suggestion filters are mutually exclusive.

The summary shows saved and suggested amounts separately for each provider, without adding the
same work twice into a combined total. Layer switches filter the calendar and phone agenda locally;
only selected provider layers receive new time. The header scope controls which systems are read.
Saved cards name their provider without comparing its total to the other system.

Overlapping ticket proposals become sequential allocations within the evidenced
stretch. Tickets share it evenly, with a fifteen-minute floor by default. When
there is not enough time for every ticket, the tickets with the most credited
evidence keep the available slots. These are proposed allocations, not exact
per-ticket activity timestamps. Separate work, idle gaps, wholly unplaced stretches and local
midnight remain boundaries. Mixed stretches reserve their unplaced share before
allocating known tickets, so changing shares do not create tiny blocks. A standalone stretch shorter than the floor stays
short; JCF never invents minutes. `jcf config set dwell <seconds>` changes the
floor; zero retains raw overlapping credit.

Ownership exceptions and days excluded by running timers appear below the calendar.

## One system or both

The header picks what the week is about: both, Jira only, or Clockify only. The choice is remembered
per browser, because someone who tracks in one system does so every week.

A system that is out is not read, not proposed for, and not written to. That is stronger than
skipping its write, and it matters: a side nobody read holds an unknown amount, and treating unknown
as zero would propose the whole day for it. In a Jira-only week no Clockify request is made at all,
so a Clockify workspace you do not use cannot fail a run that never needed it.

The confirmation panel carries the selected provider layers as write targets. A hidden provider
is disabled in that panel and excluded from both approval and manual requests, even if the editor
was opened before the layer changed. A side you did not ask for is reported as skipped and
its gap is left exactly as it was, so asking for Jira today and both tomorrow writes the Clockify
half tomorrow.

## Filling a gap

Clicking a dashed block opens a panel, not a modal — filling several in a row means comparing each
against the calendar it came from. The panel states the evidence, when the work happened, what each
system already holds, and the exact text that will be written, before its confirm button does
anything. Clicking empty space offers a manual entry at the time clicked, which is the gesture a
calendar teaches.

Two things may be overruled, and both are said out loud in what gets written:

- **The amount**, downward to any duration and upward only to the credited evidence. Above that the
  write is refused with the ceiling named, because a tool that can invent hours is the one failure
  every rule in the engine exists to prevent. Time no session evidences is logged as a manual entry
  instead, which claims no evidence at all.
- **The Issue Key.** An override is re-tallied against the bucket it moves to before anything is
  written: the target may already hold time the row knew nothing about, and sizing the write from the
  plan's own numbers would log that time twice. Confirmed source blocks are linked to the resulting
  provider entry IDs in a private owner-only ledger. Editing a description, including removal of a
  `[jcf-source:…]` suffix, does not make confirmed time eligible again after a restart.

## Safety

- Loopback only, one process, one operator. A read needs the session cookie; a write needs the
  cookie, a matching origin, and the CSRF token this tab holds.
- A confirmation names a row of a plan the server still holds and carries no evidence of its own, so
  a browser cannot post its own spans or its own credited seconds.
- Every write re-reads what Jira and Clockify hold at that moment and combines their current entry
  durations with private provider-ID source bindings. Confirming the same row twice writes once;
  editing its description does not reset consumption. Nothing is remembered about what was declined.
- A provider create with an uncertain result is held for manual recovery, not retried. Older
  unlinked entries also require private review before first use; a missing or unreadable ledger is
  never treated as proof that historical time was not written.
- Browser confirmations, manual entries and saved-entry edits share the machine writer guard with
  `jcf watch`. A browser write is refused while the watch runs; a browser mutation holds the guard
  only until its provider operation finishes and does not publish a watch resume cursor.
- Nothing is ever modified or deleted in either system. Reconciliation only adds.

## Responsive review and progress

The calendar uses Rly's Geist fonts, semantic colors, fields, controls and state
panels. Appearance can follow the system or use light or dark mode.

On phones, the week opens as an agenda with readable ticket titles and times.
Calendar and Agenda controls switch presentations at any width. The calendar
scrolls inside its own area, keeping the page and editor within the viewport.
The editor has a reserved column beside the week on wide screens. On smaller screens
it floats over at most 75% of the viewport and scrolls internally. Opening, saving,
and closing it preserve the calendar's visible time position. Save results and totals
refresh progress appear in compact floating feedback without moving the calendar.
Opening an editor moves keyboard focus into it without scrolling; Escape or Cancel
returns focus to its trigger. If saving removes that suggestion, focus returns to the week.
Use Log time to enter work without clicking a calendar slot, including selecting
the day and start time.

Explicit session scans stream authenticated NDJSON from `/api/week/stream`. The existing JSON
read remains available. Progress names the actual stages: reading sessions,
matching tickets, reading logged time, checking Jira titles and ownership, and
building the calendar. AI attribution includes completed and total session counts.
Agent activity shows a read-only conversation for each batch: the supplied request first,
then the live response underneath. Both are selectable text with separate scroll areas;
complete JSON answers are indented. Partial output preserves its text as it arrives.
Batch buttons select concurrent conversations.
Scans open their progress, stage details and conversation in the right panel, sharing the calendar editor's reserved
space. Close or Escape dismisses it; Agent requests and responses reopens it. Narrow
screens use the bounded editor overlay, so the conversation does not push the calendar down.
Completed conversations remain available after loading and after totals-only refreshes.
Status-only events leave the text unchanged. No terminal renderer or input connection is required.
The response streams visible Claude text and structured answer fragments before each batch finishes.
It retains up to eight batches with up to 64,000 characters each for request and response;
longer text is explicitly marked as truncated. Requests contain the supplied session evidence.
Output is owner-authenticated; system configuration and reasoning events are excluded.
Loading details expands the stage history; elapsed time is measured in the browser.
The progress bar is indeterminate when the server cannot report a total.

The last loaded calendar remains visible during a refresh. Cancel read disconnects
that request and cancels its scoped server work; it never logs time. Choosing a
new week or system cancels the earlier read. Only the newest read may update the
calendar or its status. Writes are disabled while the displayed week is stale or
loading, and remain explicit actions that recheck server-held evidence.
Partial provider failures are shown as incomplete writes, never as full success.

After a confirmed or manual write, `/api/week/recorded` rereads Jira/Clockify totals
and running timers against the server-held session evidence. It recalculates gaps
without reopening transcripts, rerunning attribution, or looking up ownership again.
Navigation is available once the write returns; time-entry controls wait for current
totals. Retrying a failed totals refresh uses the same evidence and never repeats the
write.

Reload restores the selected week and scope through `/api/week/saved`, then refreshes
provider totals. The server retains the six most recent week/scope plans in memory.
When no plan is retained, `/api/week/recorded-only` loads saved provider entries
and running timers without reading sessions. Manual logging remains available.
A restart or eviction requires Rescan sessions only to restore suggestions.
Navigation, Refresh totals and configuration changes never start an agent automatically.

Agent settings selects Claude or Codex, an optional model name and a provider-supported
effort. Blank model and default effort leave those choices to the CLI. Saving persists
`sessionAgent` in JCF config and applies to subsequent attribution and description
operations. It does not rescan the displayed week. The selected CLI must be installed
and authenticated. Both providers receive only the supplied evidence in prompt-only
mode; their visible activity streams into the conversation.

Rescan sessions reads both Claude Code and Codex history within the configured session roots,
regardless of the matching agent selected. Codex sessions resumed from older date directories
are included. Reload continues to restore the existing plan; use Rescan sessions to pick up new
work or newly supported transcripts. The 15-minute suggestion minimum still applies.

Effect Atom shows pending Jira and Clockify slots immediately when a write starts.
Each provider settles separately: failed entries disappear and successful entries
remain visible while totals refresh, including when that refresh fails. The server
still sizes the actual write from live provider totals.

Use the + button on any calendar or agenda suggestion to queue its suggested time
with the current provider layers and default note. It skips the editor and never
requests a generated description. The ordinary card keeps its selected Review first
or Quick approve behavior. Its provider slots appear
immediately, with Undo available for at least five seconds and until saving starts.
Keep selecting other suggestions while the queue saves serially in the background.
The bounded queue floats beside the calendar, so + and Undo keep the visible time fixed.
The app refreshes provider totals once the queue drains. A queued write captures the
selected provider layers; hiding a provider before dispatch removes it from that
write. Showing another provider does not add it to an existing approval.
Week navigation and manual entry wait for the queue to finish. Reload cancels unsent
approvals; a request already sent can still finish. Undo does not delete saved entries.
Choose Review first to adjust the clicked block's amount or note before logging.
The editor shows that block's time range and submits only that block.
Work descriptions use a resizable multiline textarea in both suggestion and manual entry forms.
Opening it requests a work description from the retained sessions for that ticket and
day, using the current agent settings. The field fills when the suggestion arrives;
typing or deliberately clearing it prevents later responses from replacing your draft.
Switching blocks of the same row keeps the draft, and approval can proceed while the
description is pending. A progress bar and loading placeholder show when the agent is
preparing the text; they clear on completion, failure or your first edit. Quick approve
never starts description generation.
Description requests share a cache for the retained plan, row and agent settings,
including an unavailable suggestion. Transport and settings errors offer Retry;
no description generation happens secretly during a write.

Jira and Clockify have independent controls and counts. Suggestions use one filter:
No overlap, Overlap, or All.
Saved entries and no-overlap suggestions are shown by default; overlapping suggestions
are available through their labelled count. Clockify entries without a ticket remain visible and editable, and contribute
to Clockify totals. Overlap checks use only the provider layers currently shown,
regardless of ticket identity. Touching endpoints do not overlap. Suggestions keep
their complete durations when changing categories; this filter never splits them.
Solid blocks are saved entries, dashed blocks are suggestions, and dotted blocks
are pending writes. Provider totals stay visible when their calendar layer is hidden.

Calendar placement is memoized per plan, pending writes and layer selection. Minimum card height
participates in collision detection, so adjacent short intervals cannot cover each other.
Suggestions require at least 15 minutes of credited time, wall duration and remaining
time in a selected provider. This filter also applies to restored scans and retains
the original block indexes. Short saved Jira/Clockify records keep their actual duration.
Narrow cards prioritize the ticket key; provider labels remain in their accessible
description, hover text and layer controls.
Overnight entries retain every affected day, including weekends. Elapsed-time updates render separately.
Response validation loads separately from the initial interface. Recorded-time
reads and running-timer checks run concurrently within the existing provider scope.

The missing-suggestions message and its Scan sessions button sit beside the desktop
calendar and below the mobile calendar, without adding a banner above the week.

## Edit saved time

Click a solid Jira or Clockify entry to open its details in the right panel. Edit the
start, end or multiline description, then Save changes. Save updates only the clicked
provider entry; it never creates another entry. Midnight slices open the entire entry.
The calendar previews the edit immediately with Effect Atom and rolls back on failure,
keeping the draft available to retry. Hiding the entry's provider layer disables Save.
Successful edits remain visible if the following
totals refresh fails. Reload restores the retained edit without rescanning sessions.

Generate description explicitly matches retained scanned sessions by ticket and their
individual active intervals. The loading indicator stays visible while the agent runs;
text typed or cleared during generation is preserved. Review the generated text before
saving. Clockify keeps the `[KEY]` prefix for a ticketed entry; Jira receives plain text.
Unkeyed Clockify entries require exactly one overlapping session. Missing or ambiguous
evidence produces no suggestion. Generation never rescans sessions or writes time.

Description edits accept up to 32,000 characters; generated text is at most 500.
Changed times use whole seconds, span at most 24 hours and overlap the selected week.
Jira starts must remain in that week and changed durations must be at least one minute;
existing shorter worklogs still allow description-only edits. Running, locked, time-off
or custom-field Clockify entries cannot be edited here. Jira description changes use
plain paragraphs, replacing formatting and embedded content; time-only edits preserve the original rich comment. Saves recheck
ownership and the retained snapshot. An opaque entry revision rejects stale drafts from
another tab; unchanged totals refreshes keep that revision valid. Older scans and
refreshes cannot replace entries edited while the read was running. Provider APIs cannot prevent an external edit
between that check and the update; local updates are serialized.
Saved-entry updates use the same machine writer guard as confirmations, so they are also refused
while `jcf watch` owns it.

## Review boundaries

`weekReview.ts` owns read replacement, freshness, cancellation, mutation locking and
refresh after writes through an Effect Atom registry. `useWeek.ts` only connects React
mounting and observation. React owns the open editor and presentation choices.
`rowDescriptions.ts` owns per-row draft atoms and pending description requests. Totals
refresh preserves them; replacement plans discard them, and settings changes invalidate
generated text while keeping user edits. The authenticated `/api/rows/describe` route
uses only the server-held proposal, digests and title, without rescanning sessions.

`calendarProjection.ts` produces provider layers, suggestion overlap counts, placements
and totals. Both calendar and agenda consume that projection. It does not allocate
session evidence or authorize writes.

The engine's pure `agent/writePlanning.ts` resolves selected blocks, ticket overrides,
amounts and per-provider starts. Preview uses cached totals; confirmation rereads live
totals and sends the resulting concrete plan to the writer. CLI and watch retain their
existing write policy through the same anchoring calculation.

## Browser checks

```bash
pnpm --filter @knpkv/jcf-web exec playwright install chromium
pnpm --filter @knpkv/jcf-web test:browser
```

The browser suite runs the production client, authenticated HTTP application and
reconciliation engine with fake provider services. It covers streamed status and
cancellation, competing reads, block selection, queued approval and Undo, keyboard focus, manual entry,
partial writes, selected write layers, agent settings, weeks without scans,
mobile overflow and both themes.
It never contacts Jira or Clockify or uses an operator's credentials.
