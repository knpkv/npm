# Propose worklogs from Claude Code Agent Sessions

Label: `ready-for-agent`
Package: `@knpkv/jira-clockify` (`jcf`)
Related: [ADR-0006](../../docs/adr/0006-treat-agent-sessions-as-reconciliation-evidence.md), [CONTEXT.md](../../CONTEXT.md)

## Problem Statement

I do most of my work through a Coding Agent, and I routinely forget to start a Timer. At the end of a
day — or worse, at the end of a week — Clockify and Jira are both missing hours I genuinely worked, and
the only record that the work happened at all is the Agent Session transcript sitting on my disk.

Reconstructing that by hand is slow and unreliable. `jcf sync reconcile` can already copy time between
Clockify and Jira, but it is useless when _neither_ side has the time: it compares two empty buckets and
reports that everything is in sync. `jcf timer log` can create a Reconstructed Interval, but only if I
can remember which Issue Keys I touched, on which days, and for how long — across three concurrent
sessions, a session I resumed the next morning, and a branch whose name says `RPS-5662` while I actually
spent the afternoon on an unrelated hotfix.

The information needed to fix this is already on my machine and completely unused.

## Solution

`jcf sync reconcile --agent claude` reads local Claude Code Agent Sessions, works out which Issue Key
each one belongs to and how much time it accounts for per day, subtracts whatever Clockify and Jira
already hold, and offers each remaining gap as a Proposed Worklog I confirm one row at a time. Accepting
a row creates both the Clockify entry and the Jira worklog, each sized to its own existing gap.

Every proposal shows the Attribution Signal that produced it, so I can see whether a row came from a
branch name, a directory path, a Standing Attribution, or a Coding Agent's reading of the transcript —
and reject the ones that look wrong. Work that cannot be attributed is reported as an Unattributed
Session with its hours, never silently dropped and never guessed at.

Agent Sessions are evidence, not a third side of the reconciliation. Nothing is ever written back to a
transcript, and the tool never claims a session's derived duration is authoritative.

## User Stories

### Producing proposals

1. As a developer who forgot to start a Timer, I want `jcf sync reconcile --agent claude` to propose the
   worklogs I am missing, so that a day of unlogged work costs me one command instead of an hour of
   recall.
2. As a developer, I want proposals bucketed by Issue Key and local calendar day, so that they line up
   with how I read my own timesheet and with how `reconcile` already presents rows.
3. As a developer, I want to confirm each Proposed Worklog individually, so that one bad attribution
   does not force me to reject the whole run.
4. As a developer, I want confirming a row to create both the Clockify entry and the Jira worklog, so
   that I do not have to remember a second command to finish the job.
5. As a developer, I want each side sized to its own gap, so that a day where Clockify has nothing but
   Jira already has an hour results in the correct amount on each side rather than the same number
   twice.
6. As a developer, I want to reconcile today, the last seven days, or a custom window, so that I can
   catch up daily or recover a whole week I let slip.
7. As a developer, I want the same `--day` / `--week` / `--since` / `--until` flags that `reconcile`
   already accepts, so that I do not have to learn a second vocabulary for the same idea.
8. As a developer, I want to see the total hours a run would add before I confirm anything, so that I can
   sanity-check it against my memory of the week.

### Attribution

9. As a developer working on a ticket branch, I want the Issue Key taken from the git branch, so that the
   common case needs no configuration and no model call.
10. As a developer using git worktrees, I want the Issue Key taken from the working directory path when
    the branch reads `HEAD`, so that detached worktrees are attributed as reliably as checked-out
    branches.
11. As a developer, I want the Attribution Signal recorded and displayed next to every proposal, so that
    I can weigh a branch-derived row differently from a model-derived one.
12. As a developer, I want Attribution Signals applied in a fixed precedence — branch, then path, then
    Standing Attribution, then Coding Agent — so that results are predictable and re-running does not
    reshuffle attributions.
13. As a developer on a long-lived integration branch such as `master`, `develop`, or
    `release-candidate`, I want the transcript itself consulted, so that real work whose ticket appears
    only in the conversation is not invisible.
14. As a developer, I want a Coding Agent to choose only among Issue Keys that literally appear in the
    transcript, so that a plausible-looking but invented key can never reach a worklog.
15. As a developer writing a release-notes or known-issues document that references dozens of tickets, I
    want the Coding Agent to be able to answer "none of these", so that referencing a ticket is never
    mistaken for working on it.
16. As a developer, I want placeholder keys such as `RPS-123`, `RPS-1234`, `RPS-333`, and `RPS-XXXX` never
    to win an attribution, so that documentation examples and branch templates do not generate worklogs.
17. As a developer whose transcript mentions no ticket at all, I want the session reported as an
    Unattributed Session, so that the hours are visible to me even when the tool cannot place them.
18. As a developer, I want a per-proposal confidence from the Coding Agent, so that I can tell a
    confident attribution from a guess before I confirm it.
19. As a developer, I want low-confidence attributions reported but not offered for confirmation, so that
    the confirm prompt stays a place where "yes" is usually correct.
20. As a developer, I want the Coding Agent asked only about sessions the deterministic signals could not
    place, so that a normal run costs nothing and finishes quickly.
21. As a developer with no Coding Agent available, I want the deterministic proposals to work anyway and
    the rest reported as unattributed, so that the feature degrades instead of failing.

### Ticket-less but real work

22. As a developer who writes release notes every release, I want a Standing Attribution mapping a
    directory to an Issue Key, so that recurring work with no natural ticket still becomes an ordinary
    proposal.
23. As a developer, I want Standing Attributions matched most-specific-prefix-first, so that
    `~/dev/docs/interviews` and `~/dev/docs/releases` can map to different Issue Keys.
24. As a developer, I want a Standing Attribution to lose to a branch or path signal, so that adding one
    can only ever add attribution and never redirect work that was already correctly attributed.
25. As a developer, I want directories I have not mapped to stay unattributed, so that a catch-all never
    quietly absorbs unrelated work.

### Duration

26. As a developer, I want the sum of proposed hours for a day never to exceed the wall clock of that
    day, so that I can trust a proposal without cross-checking it against every other row.
27. As a developer running three sessions at once, I want each instant credited to at most one Issue Key,
    so that concurrency does not inflate my week.
28. As a developer who resumed a session the next morning, I want the overnight gap credited to nothing,
    so that a session spanning two days does not bill the night between them.
29. As a developer who left a session open over lunch, I want gaps beyond the Idle Cap excluded, so that
    time away from the keyboard is not logged as work.
30. As a developer, I want to configure the Idle Cap, so that I can adapt it if my working rhythm changes.
31. As a developer, I want an interval spanning local midnight split at midnight, so that each day's
    bucket is exact and matches the day boundaries `reconcile` already uses.
32. As a developer, I want proposals expressed to the minute with no rounding, so that the number I log is
    the number the evidence supports rather than one adjusted for tidiness.

### Scope

33. As a developer, I want to declare which directories contain billable work, so that my personal
    projects and scratch directories never generate proposals against a real ticket.
34. As a developer, I want sessions outside every Session Root never even read, so that no unrelated
    transcript reaches a Coding Agent.
35. As a developer, I want work in a directory I have not opted in to be omitted rather than guessed at,
    so that the failure mode is a missing proposal I will notice rather than a wrong one I might confirm.
36. As a developer, I want to configure Session Roots and Standing Attributions through `jcf config`, so
    that I do not have to hand-edit JSON.

### Safety and repeatability

37. As a developer, I want a proposal to be what the session accounts for minus what Clockify and Jira
    already hold, so that running the command twice cannot double-log.
38. As a developer who already logged part of a day with a Timer, I want that time subtracted, so that
    the proposal tops up the day rather than duplicating it.
39. As a developer with a Timer currently running, I want that day reported but never proposed, so that
    time not yet closed into Clockify cannot be counted twice when I stop the Timer.
40. As a developer, I want to be told explicitly why a day was skipped for a running Timer, so that I know
    to stop the Timer and re-run rather than assuming there was nothing to log.
41. As a developer, I want nothing written without an explicit confirmation, so that the command is safe
    to run out of curiosity.
42. As a developer, I want a preview that writes nothing, so that I can see what a week would produce
    before committing to any of it.
43. As a developer running this from a script or an agent, I want machine-readable output that performs no
    writes, so that automation can read my proposals without being able to act on them.
44. As a developer piping output, I want progress and hints on stderr and exactly one JSON value on
    stdout, so that the output composes with other tools.
45. As a developer, I want a failure partway through a run not to undo the rows already accepted, so that
    a network error costs me the remainder of the run rather than the whole thing.
46. As a developer whose Jira session has expired, I want to be told once and have the run stop, so that I
    do not confirm twenty rows that all fail.

### Surface and errors

47. As a developer, I want `--agent` combined with a `direction` to be a clear usage error, so that I am
    never left guessing which of two arguments the tool honoured.
48. As a developer, I want an unsupported agent name to produce an error naming the supported values, so
    that `--agent codex` tells me where I stand instead of silently finding nothing.
49. As a developer, I want the created Clockify entry and Jira worklog to record that they came from an
    Agent Session, so that a worklog I am asked about months later explains itself.
50. As an agent operating `jcf`, I want this command documented as a Remote Write Command requiring
    Explicit Intent, so that I do not run it unattended.

## Implementation Decisions

### Command Surface

- `--agent <name>` is added to the existing `reconcile` command inside the `sync` group. It is a **mode
  switch**, not a new direction: passing both `--agent` and the positional `direction` is a usage error.
  Only `claude` is accepted; any other value fails with a message naming the supported values.
- The window flags (`--day`, `--week`, `--since`, `--until`) and the local-day, half-open `[from, to)`
  period resolution are reused unchanged from `reconcile`.
- Considered and rejected: a sibling `jcf sync sessions` command, and a `jcf session propose` Resource
  Command. Both were cleaner against ADR-0002's resource-first posture, but the mode flag keeps one
  reconciliation entry point. ADR-0002 is not violated: `reconcile` remains a Sync Workflow Command.
- The command is a Remote Write Command. It obeys the JSON Output Contract: `--json` emits exactly one
  JSON value on stdout, sends everything human-facing to stderr, and performs no writes. Absence of a
  TTY is treated the same way — report only.

### Modules

- **A pure agent-session core**, provider-agnostic and free of I/O, owning: the last-touch partition, the
  Idle Cap, midnight splitting, the Attribution Signal precedence, Standing Attribution prefix matching,
  Session Root prefix matching, transcript key mining, and the proposal delta. Every decision-bearing rule
  lives here as an exported pure function, following the precedent of the pure helpers already exported
  from the reconcile service.
- **An agent-session reader service** that discovers Claude transcripts under the configured Session
  Roots, decodes their JSONL line-by-line, and yields Session Activity plus the working directory and git
  branch. Malformed or unrecognised lines are skipped rather than failing the run — the transcript format
  is an external contract that changes without notice.
- **A `SessionAttributor` service** with a single narrow operation: given candidate Issue Keys mined from
  a transcript plus a compact session digest, return a chosen key with a confidence, or "none". The real
  implementation wraps `@knpkv/ai-claude`; the service boundary deliberately keeps `LanguageModel` out of
  every consumer and test. It is consulted only for sessions no deterministic signal placed.
- **The reconcile service** gains a proposal operation that composes the above with its existing Clockify
  and Jira tallies. Its existing `compare`, `applyToJira`, and `applyToClockify` operations are reused for
  reading current state and performing writes; no new write path is introduced.
- **Config** gains `sessionRoots` (ordered prefixes), `sessionTicketMap` (Standing Attributions, matched
  most-specific-first), `sessionIdleCapSeconds` (default 300), and a confidence floor. These follow the
  existing `projectMap` idiom and the existing merge-partial-over-defaults behaviour, so an absent or
  corrupt config falls back to defaults rather than failing.

### The partition rule

From the prototype run against 60 days of local transcripts. This encodes the decision more precisely
than prose:

```
events := all Session Activity in scope, sorted by timestamp (global, across sessions)

for each adjacent pair (e[i], e[i+1]):
    credited := min(e[i+1].timestamp - e[i].timestamp, idleCap)
    credit `credited` to attribution(e[i].session), on localDay(e[i].timestamp)
    # split at local midnight when the interval crosses it
```

Because each interval is credited exactly once and only to the earlier event's Issue Key, Σ over all
Issue Keys ≤ (last event − first event) for the day. That inequality is the safety property; it is not an
emergent behaviour to be tested for so much as the reason this shape was chosen.

### Attribution precedence

1. Ticket key in the git branch.
2. Ticket key in the working directory path.
3. Standing Attribution for the longest matching directory prefix.
4. `SessionAttributor`, choosing among keys mined from the transcript, or "none".
5. Otherwise an Unattributed Session, reported with its hours.

The attributor's choice set is closed over the transcript's own text, which makes an invented key
structurally impossible rather than prompt-dependent.

### Proposal and write semantics

- Proposed amount per `(Issue Key, day)` and target = `partitioned seconds − seconds that target already
holds`, floored at zero. Below-one-minute proposals are not offered, matching the existing 60-second
  tolerance that exists because Jira floors worklogs to the minute. No other rounding is applied.
- If a Timer is running, the local day it started on is reported with an explanation and **excluded from
  proposals**. This is load-bearing: a running Timer's Clockify entry has no end time, and the Clockify
  tally skips entries without an end, so its time is invisible and would be double-counted on stop.
- Idempotency comes from live-state subtraction only. No decision state is persisted, so a declined
  proposal reappears on the next run, and a manually deleted Clockify entry is correctly re-proposed.
- Writes carry provenance identifying the Agent Session origin, but provenance text is **not**
  load-bearing for correctness — editing a description in Clockify's web UI must not re-enable
  double-logging.
- The first `NotLoggedIn` outcome from Jira stops the run, matching the existing behaviour in `reconcile`.

### Effect conventions

`Context.Service` classes with explicit `Layer.effect` layers; services bound before use inside
generators; tagged domain errors in the typed error channel; `FileSystem`, `Path`, and `Clock` from Effect
rather than host APIs; untrusted transcript JSON decoded through Schema helpers before it reaches a domain
type.

## Testing Decisions

A good test here asserts only externally observable behaviour: what the command prints, what it proposes,
what it writes, and what it refuses. It does not assert how attribution was implemented, how transcripts
were parsed, or in what order services were consulted. Tests must be timezone-independent — dates are
constructed from local components, as `ReconcileService.test.ts` already does — and must not read the real
`~/.claude` directory or the user's real config.

### Seam 1 — the CLI, through a new `FakeHeadlessLayer` (highest seam, primary)

The existing `HeadlessLayer` is fully live, which is why `commandSurface.test.ts` can only assert
`--help` outcomes today. A `FakeHeadlessLayer` will be introduced that satisfies the same shape with
faked Clockify, Jira, Jira auth, Clockify auth, config, filesystem, and `SessionAttributor`, letting the
whole command be exercised end to end. **This is a deliberate investment beyond the feature**: it makes
behavioural CLI tests possible for `reconcile` and the Timer commands too, and it is the highest seam
available in the package.

Behaviour proven here:

- A day of transcript activity yields the expected Proposed Worklogs and the expected writes to both
  Clockify and Jira, captured from the fakes.
- Declining a row writes nothing; accepting writes exactly once.
- `--agent` plus a `direction` exits as a usage error.
- An unsupported agent name errors and names the supported values.
- Overlapping concurrent sessions never produce a day total exceeding wall clock.
- A resumed session spanning midnight bills neither the overnight gap nor the wrong day.
- A running Timer causes its day to be reported and excluded, with the reason stated.
- A second run immediately after a successful first run proposes nothing.
- `--json` emits exactly one JSON value on stdout, writes nothing, and keeps hints on stderr.
- With the attributor unavailable, deterministic proposals still appear and the rest are reported as
  Unattributed Sessions.
- The attributor is called **zero** times when every in-scope session is attributed by branch — the cost
  guarantee, asserted from the fake's captured call list.
- Sessions outside every Session Root reach neither a proposal nor the attributor.

### Seam 2 — pure functions, direct import (existing seam, reused)

The partition, Idle Cap, midnight split, precedence, prefix matching, transcript key mining, and delta
arithmetic are exported pure functions tested by direct import, exactly as `buildReconcileRows`,
`parseTicketKey`, `localDay`, `combineDescriptions`, and `deltaToApply` already are. This is where edge
cases are enumerated cheaply: zero events, one event, adjacent identical timestamps, an interval exactly
equal to the Idle Cap, a session whose every candidate key is a placeholder, competing Standing
Attribution prefixes.

### Prior art

- `ReconcileService.test.ts` — pure helpers imported directly, timezone-independent date construction.
- `TimerService.test.ts` — a real service layer over hand-written fakes, with writes captured into arrays
  and asserted; the pattern `FakeHeadlessLayer` generalises, and the prior art for faking Clockify and
  `HttpClient` and for driving time with `TestClock`.
- `commandSurface.test.ts` — the canonical-versus-rejected command table this feature extends.
- `@knpkv/ai-runtime`'s deterministic agent fake — prior art for a fake that captures the requests made
  to it, which is the shape the `SessionAttributor` fake should follow so call counts can be asserted.

### Fixtures

Transcript fixtures are hand-written minimal JSONL committed with the tests, covering: a branch-attributed
session, a `HEAD` worktree session attributed by path, an integration-branch session needing the
attributor, a multi-key release-notes session whose correct answer is "none", a session with no key at
all, malformed and unrecognised lines mid-file, and two overlapping concurrent sessions. Real transcripts
are never read by tests, and no fixture contains a real Issue Key or employer name.

## Out of Scope

- **Codex and any other Coding Agent.** Codex transcripts carry a working directory and timestamps but no
  git branch, and are laid out by date rather than by project, so attribution there leans far harder on
  the model. `--agent codex` errors explicitly. The pure core is provider-agnostic so that adding it later
  is additive.
- **Extracting a `@knpkv/agent-sessions` package.** The core is pure precisely so this stays cheap, but
  there is one consumer today.
- **TUI integration.** CLI only for this iteration; no proposal review inside the `jcf` TUI.
- **Splitting one session across several Issue Keys.** A session is attributed to at most one ticket. A
  ticket switch inside a single session is not detected.
- **Distributing ticket-less time across referenced tickets.** Rejected in favour of Standing Attribution.
- **Any write back to a transcript**, and any modification or deletion of existing Clockify entries or
  Jira worklogs. Reconciliation only ever adds.
- **Reading transcripts from other machines**, or any sync of Session Roots between machines.
- **Automatic Session Root discovery.** Opt-in only.
- **Calibrating derived time to a target workday length.** Rejected in ADR-0006.

## Further Notes

**Measured evidence behind the defaults.** All figures from the author's local Claude Code transcripts,
gathered while specifying this:

- The git branch or working directory path yields an Issue Key for **107 of 148** in-scope sessions
  (72%). It yields nothing for integration branches (`master` on an integration repo, `develop`, a
  `release-candidate` worktree), which is real billable work.
- Of the 41 residual in-scope sessions, **32 mention several** Issue Keys, 4 mention exactly one, and 5
  mention none. One known-issues document mentions four keys 60, 49, 37 and 28 times respectively — for
  tickets that were written _about_, not worked _on_. Frequency is therefore anti-correlated with what
  should be billed, which is why transcript mining alone was rejected and why the model's job is framed as
  "worked on versus referenced".
- Idle Cap comparison across 38 days: 5 minutes gives 5–9h days; 15 minutes gives 6–12h; 30 minutes gives
  11–13h. 5 minutes was chosen as the only setting producing defensible daily totals.
- Attributed proposals run at **3.4 rows per day** over 37 days (125 buckets, 143.7h) — a reviewable
  volume for row-by-row confirmation.
- Rounding, over the same 143.5h: to 1 minute +0.0%, to 5 minutes −0.2%, to 15 minutes **+1.7%**. Fifteen
  minute rounding would invent roughly 2.5h a month while a 15-minute minimum simultaneously discarded
  4.1%, so both were rejected in favour of exact minutes.
- A scope allowlist needs **two entries**; a denylist would need five today and one more per side project.
  `/private/tmp` (59 sessions) and a nix config directory (26) are the largest sources of non-billable
  activity.

**A known limitation worth stating plainly.** A branch name is a claim about intent, not a record of what
happened. Time spent on an unrelated hotfix while sitting on a ticket branch is credited to the branch's
ticket, silently, because the branch signal outranks the transcript. Detecting an intra-session ticket
switch is out of scope; the Attribution Signal shown on every row is what makes the mistake visible and
rejectable.

**Vocabulary.** Coding Agent, Agent Session, Session Activity, Attribution Signal, Standing Attribution,
Session Root, Unattributed Session, Attributed Interval, Idle Cap, and Proposed Worklog are defined in
`CONTEXT.md`. Use them; in particular do not let "agent time", "session duration", or "derived worklog"
creep into code or output.
