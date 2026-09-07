---
"@knpkv/jira-clockify": minor
---

Two additions, both about what a row is made of.

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

Every failure mode leaves a key *unknown* rather than "not yours": no login, an unreachable site, an
issue in a project you cannot see. A caller may act on Jira saying a ticket belongs to somebody
else; acting on Jira not having been asked would hide hours that really happened.

Configured by `jcf config set ownership assigned|any` (default `assigned`) and
`jcf config set mine <ISSUE-KEY>` for your work on somebody else's ticket, both shown by
`jcf config show`.
