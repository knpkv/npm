# Treat agent sessions as reconciliation evidence, not a reconciliation side

`jcf sync reconcile` compares two authoritative sides, Clockify and Jira, and fills whichever is
short. Agent Sessions are deliberately _not_ modelled as a third such side: a transcript records that
work happened at particular moments, but never how long it lasted, so it can be evidence for a
Proposed Worklog and can never be a write target or be described as "in sync". `--agent` is therefore
a mode switch on `reconcile` that produces reviewable proposals carrying their Attribution Signal, and
combining it with a `direction` is a usage error rather than a silently ignored argument.

Session time is derived as an **equal split of overlapping presence windows, bounded by an Idle Cap**.
Presence is evidenced only by messages the person typed — a Coding Agent's own output and its tool
results are excluded, because they show the agent was busy rather than that anyone was working. A
session is present between its own adjacent prompts, gaps longer than the Idle Cap are credited to
nothing, and any instant where several Issue Keys were being worked is divided equally between them. The sum
across all Issue Keys is therefore arithmetically incapable of exceeding wall clock, which is the
property that makes a proposal safe to accept without auditing it against the rest of the day.

## Considered Options

Measured against 60 days of local Claude Code transcripts before deciding.

- **A third symmetric side** (`claude-to-clockify`, `claude-to-jira`). Rejected: it asserts that derived
  time is as authoritative as a recorded Clockify entry, and makes "Clockify is 2h short versus Claude"
  a defect the tool must offer to fix.
- **Per-session active windows, summed.** Rejected on data: sessions overlap heavily — three ran
  concurrently on 2026-07-24 — so one day summed to roughly 20 hours and every multi-session day would
  need manual arbitration.
- **Last-touch partition.** Originally chosen and now superseded. It credited an overlapping stretch
  entirely to whichever session was touched most recently, which makes parallel work a race decided by
  which session happened to emit an event — effectively rewarding the chattier one. It also required
  borrowing a _different_ session's next event to give a one-event session a duration.
- **Tickets and days only, no derived duration.** Rejected: the most honest option, but 2026-07-21 alone
  had ten attributed buckets, so it removes the labour saving that motivates the feature.
- **Calibrating the Idle Cap to a target workday length.** Rejected: it invents hours on a short day and
  discards them on a long one, breaking the traceability from proposal back to evidence.

### Counting agent output as presence

Measured on one real day: 1641 in-scope transcript events, of which **66** were typed by a person.
1039 were the agent's own turns and 532 were tool results, which the transcript records as `user`
messages despite nobody typing them. Counting every event made the day read as 3h 51m; counting only
prompts made it 1h 53m, which matched the author's own account of the day.

Counting everything also made the Idle Cap nearly inert — because agent output is dense, every
setting from one minute to ten produced between 3.0h and 4.2h. Under presence counting the same range
spans 0.6h to 2.7h, so the knob controls something real.

The cost is that supervised autonomous work is under-counted: watching a Coding Agent work for twenty
minutes without typing credits only the Idle Cap. That is the same asymmetry recorded below, and it is
recoverable with `jcf timer log`.

### Superseding the last-touch rule

The objection originally recorded against splitting — that a session left open all afternoon would
halve every other Issue Key's credit — is much weaker once the Idle Cap is in force: a session is only
active in Idle-Cap-bounded windows around its own events, so an idle session dilutes nothing. The
remaining objection, fractional minutes, is handled by flooring each share, which also keeps the
sum-under-wall-clock property exact rather than approximate.

## Consequences

A Proposed Worklog under-counts genuine reading and thinking time between prompts, because a 5-minute
Idle Cap treats those gaps as idle. This is deliberate and asymmetric: under-counting is recoverable
through `jcf sync reconcile clockify-to-jira` or `jcf timer log`, whereas over-counting means having
already billed time that was not worked.

An Issue Key worked on in parallel with others is credited less than the wall clock it occupied, so a
row's credited total can be lower than the clock ranges printed beneath it. The report states the
active total and the shared amount for exactly this reason, and the calendar marks a shared minute
rather than assigning it to one key.

A session with a single recorded event is credited nothing, because one event carries no duration.

Because proposals are `session − (already recorded)`, the feature needs no persisted decision state and
inherits `reconcile`'s idempotency. The cost is that a proposal declined on purpose reappears on the
next run.
