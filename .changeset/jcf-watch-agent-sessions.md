---
"@knpkv/jira-clockify": minor
---

Add `jcf watch claude`, which logs Agent Session time as it happens instead of being asked for it
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
