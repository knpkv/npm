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

A written entry now says how its amount was arrived at: `WriteOrigin` distinguishes time a transcript
evidences from an amount a person set or typed, and the provenance text follows. A row whose amount
was overridden must not keep claiming a transcript stands behind it.
