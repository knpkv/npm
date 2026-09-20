---
"@knpkv/jcf-web": minor
---

Make the web week responsive with a mobile agenda, Rly fields and status panels,
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
