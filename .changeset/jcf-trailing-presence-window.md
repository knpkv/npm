---
"@knpkv/jira-clockify": patch
---

Credit the Idle Cap after a session's _final_ prompt, not only after prompts that happen to be
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
