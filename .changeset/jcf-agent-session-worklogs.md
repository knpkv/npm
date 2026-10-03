---
"@knpkv/jira-clockify": minor
---

Add `jcf sync reconcile --agent claude`, which reads local Claude Code Agent Sessions as
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
