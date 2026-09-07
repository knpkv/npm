---
"@knpkv/jira-clockify": minor
---

Expose the headless engine so a second surface can derive and write Proposed Worklogs. The package
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
