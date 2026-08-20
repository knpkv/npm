# Write unattended only what has settled and was deliberately attributed

`jcf sync reconcile --agent` puts a person in front of every write, and ADR-0006 treats that review
as part of what makes derived time safe to log. A Session Watch removes the person, so it has to
replace them with rules rather than simply drop the check. Three do the work:

- **Only a Settled Block.** A block of presence is written no sooner than one Idle Cap after its last
  moment. The bound is exact rather than cautious: a window that could still overlap a block ending
  at `T` must close before `T + Idle Cap`, because a longer gap is not presence at all. Once that has
  passed, neither the block nor its share of parallel work can change.
- **Only a person's own Attribution Signal.** A branch name, a worktree path, and a Standing
  Attribution are all things someone deliberately created. A Coding Agent's reading of a transcript
  is not, so it is reported and left for `reconcile`, where it is shown before it is written.
- **Only forward, and only as far as a watch already reached.** The window starts when the watch
  does. A watch leaves a cursor behind, so a restart resumes the stretch it was holding rather than
  dropping it — bounded by one settle window, since nothing newer than that can have settled and so
  cannot have been written. A first-ever run has no cursor and no reach. Anything older is
  `reconcile`'s job.
- **One writer at a time, per machine.** Subtracting what the two sides hold makes a _later_ look
  safe and says nothing about a _simultaneous_ one: two watches can derive the same gap before either
  writes it. A lease in the config directory, refreshed each look, settles that.

A Session Watch therefore needs no record of what it has written. A proposal is still
`session − (already recorded)`, so a failed write, a half-written row, or a laptop that slept all
afternoon shows up as the same gap on the next look, and a block already written produces no
proposal at all. This is the same idempotency ADR-0006 relies on, used a second time.

## Considered Options

- **Write the current block and keep amending it.** Rejected. It matches what a live timer looks like
  in Clockify, but the amend has no counterpart in Jira — worklog ids would have to be tracked and
  edited — and it asserts a duration for work still in progress, which is precisely what ADR-0006
  says a transcript cannot evidence.
- **Write the delta every tick.** Rejected on arithmetic: correct, idempotent, and it produces a
  one-minute Clockify entry per tick, each with its own Coding Agent call for its sentence.
- **Re-attribute with a Coding Agent every tick, cached by session.** Rejected as a cache for a
  question that should not be asked. A watch that writes unattended should not be writing a model's
  guess at all, and once that is settled the cache has nothing left to hold.
- **Catch up on the day at startup.** Rejected. It is the one behaviour that writes hours the user
  has never seen, and the command that shows them first already exists.
- **Watch the transcript files instead of polling.** Rejected on how the files are written: a Coding
  Agent appends continuously while it works, so a file watcher fires constantly and says nothing
  about presence. Nothing is writable until it has settled anyway, so a faster signal buys no earlier
  write.

## Consequences

Work a Coding Agent would have placed is not logged by a watch at all. On a machine where branches
are not named after issues, that is most of it, and the command says so on the first look rather than
appearing to work. `jcf sync reconcile --agent claude` remains the way to place it.

Time is written up to one Idle Cap plus one interval after it was worked, so a timesheet watched all
day is complete only shortly after the day is. A watch stopped mid-block loses nothing: the tail
inside the resume window is picked up by the next run, and anything older is still `reconcile`'s to
propose.

The lease is machine-local. Two watches on two machines against one Clockify account would still
duplicate, and cannot be prevented from here — that needs an idempotency key the remote side
honours.

Jira refusing the login stops the watch instead of retrying. Continuing would log to Clockify alone
for hours and rebuild the discrepancy the tool exists to close.

A Timer left running excludes every day it spans, not only the day it started on. Its hours are
invisible to the Clockify tally on each of them, and the start day was only ever the one a shorter
rule noticed.
