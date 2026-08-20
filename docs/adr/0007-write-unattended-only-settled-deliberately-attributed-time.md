# Write unattended only what has settled and was deliberately attributed

`jcf sync reconcile --agent` puts a person in front of every write, and ADR-0006 treats that review
as part of what makes derived time safe to log. A Session Watch removes the person, so it has to
replace them with rules rather than simply drop the check. Four do the work:

- **Only a Settled Block.** A block is written once its own end has passed, plus a small grace for
  transcript-write latency. A block already runs one Idle Cap past its last prompt, and the only way
  a later prompt can extend it is by landing within an Idle Cap of that prompt — which is before the
  block ends. So once the end has passed, neither the block nor its share of parallel work can
  change.

  An earlier version of this rule argued the bound differently: that a window able to overlap a block
  ending at `T` must close before `T + Idle Cap`, so `T + Idle Cap` was safe. That is wrong, and the
  error is worth recording. A window is _capped_, not bounded by its closing prompt — the prompt that
  closes it may arrive arbitrarily late and the window still exists, truncated. So a late prompt could
  conjure a window over a block already written, halve its share after the fact, and have its own
  share written too, putting more time on two Issue Keys than the clock holds. Materialising a
  session's trailing window as soon as its prompt is seen is what makes the bound true, because then
  every window a prompt will ever produce exists the moment the prompt does.

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

  Three properties of that lease are load-bearing, and each was got wrong first. It is won by an
  exclusive _create_, so two watches starting together cannot both read it as free. Taking over an
  abandoned lease cannot be an exclusive create, so the taker signs it and reads it back — and every
  refresh checks the signature, which is what bounds the case of a look that runs past its own expiry
  and is displaced while still working. And a lease that cannot be _written_ is not a lease held: an
  unwritable config directory once looked exactly like a lease already existing, and the watch went on
  to write with nothing protecting it.

  Machine-local is the honest scope. Two machines watching one Clockify account can still write the
  same hours twice, and nothing here can see that; closing it needs an idempotency key the remote side
  honours.

A Session Watch therefore needs no record of what it has _written_. A proposal is still
`session − (already recorded)`, so a failed write, a half-written row, or a laptop that slept all
afternoon shows up as the same gap on the next look, and a block already written produces no proposal
at all. This is the same idempotency ADR-0006 relies on, used a second time.

It does keep one thing: how far it has _resolved_. Without that, "resume the tail a stopped run was
holding" and "back-date a settle window on every start" are the same behaviour, and only one of them
is defensible.

That word is exact, and the first two attempts at it were not. The cursor is not how far the watch
_looked_ — a run stopped mid-block had looked past prompts it was still holding, so resuming from
there filtered out the very prompts that made the block unsettled and lost the block the cursor
existed to protect. Nor is it how far the watch _settled_: a settled block is not finished with until
both sides that were short have taken it, so a Jira refusal after Clockify succeeded would otherwise
persist a cursor past a row whose Jira half was missing — and the restart the command asks the user
for would skip it. A dry run resolves nothing at all, by the same rule. The cursor is the earliest
instant this run has not finished with, which is the start of the oldest block it still holds.

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
