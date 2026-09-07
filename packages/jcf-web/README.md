# @knpkv/jcf-web

A week of Jira and Clockify time in a browser, with the gaps a Coding Agent's sessions evidence
offered for confirmation one row at a time.

`jcf sync reconcile --agent claude` already derives those gaps and writes them from a terminal. This
is the same engine — `@knpkv/jira-clockify`, the same services against the same config — behind a
grid, because a gap only means something next to the time already logged around it, and a week is how
a timesheet is actually read.

## Running it

```bash
pnpm --filter @knpkv/jcf-web build   # the client is a static bundle the server serves
pnpm --filter @knpkv/jcf-web start   # prints the URL that gets you in
```

The printed URL carries a one-time code in its fragment. Opening it exchanges the code for a session
cookie and strips it from the address bar; reloading afterwards works because the cookie is what
authenticates. The code expires a minute after the server binds, so restart to get a fresh one.

For development, `pnpm --filter @knpkv/jcf-web dev` runs the server and Vite together and prints a
URL on the dev origin, which proxies the API and the bootstrap exchange so the browser stays on one
origin.

`PORT` moves the server (3111 by default).

## What the calendar shows

Hours down, days across, and every block at the time it actually happened — one ISO week, Monday
first, so a week is the same week every time you open it. Saturday and Sunday appear only when they
hold something. The visible hours are a working day, widened to cover anything outside it, because a
23:40 session is exactly what someone opens this to find.

Two kinds of block, in one visual language:

- **Logged**, solid, from the intervals the systems reported — a Clockify entry knows when it ran, a
  Jira worklog states a duration from a start. One block per entry, outlined when the other system
  holds less for the same ticket and day: that disagreement is the original problem the tool exists
  for, so it is marked rather than averaged away. Time only Jira holds is its own block, because that
  direction is a discrepancy too.
- **Proposable**, dashed, from the credited spans of the sessions behind it, with the Attribution
  Signal that placed it — a branch name, a working directory, a Standing Attribution, or a Coding
  Agent's reading of the transcript.

Blocks are as long as the work was, not as long as the transcripts interleave. Ownership changes no
more often than the engine's Dwell Floor — fifteen minutes by default — so a minute on another branch
in the middle of an hour's work belongs to the hour, and a day reads as a handful of blocks rather
than two dozen slivers. `jcf config set dwell <seconds>` moves it; zero shows the raw interleaving.

Three lanes sit under the calendar, none of them decoration: hours a Coding Agent placed too weakly
to offer, hours nothing placed at all, and days withheld because a Timer is still running. Each is
time that exists and cannot be drawn at a time, so hiding it would make the calendar a lie.

## One system or both

The header picks what the week is about: both, Jira only, or Clockify only. The choice is remembered
per browser, because someone who tracks in one system does so every week.

A system that is out is not read, not proposed for, and not written to. That is stronger than
skipping its write, and it matters: a side nobody read holds an unknown amount, and treating unknown
as zero would propose the whole day for it. In a Jira-only week no Clockify request is made at all,
so a Clockify workspace you do not use cannot fail a run that never needed it.

Each write can still overrule the week: the confirmation panel carries the two systems as
checkboxes, defaulted to the week's own scope. A side you did not ask for is reported as skipped and
its gap is left exactly as it was, so asking for Jira today and both tomorrow writes the Clockify
half tomorrow.

## Filling a gap

Clicking a dashed block opens a panel, not a modal — filling several in a row means comparing each
against the calendar it came from. The panel states the evidence, when the work happened, what each
system already holds, and the exact text that will be written, before its confirm button does
anything. Clicking empty space offers a manual entry at the time clicked, which is the gesture a
calendar teaches.

Two things may be overruled, and both are said out loud in what gets written:

- **The amount**, downward to any duration and upward only to the credited evidence. Above that the
  write is refused with the ceiling named, because a tool that can invent hours is the one failure
  every rule in the engine exists to prevent. Time no session evidences is logged as a manual entry
  instead, which claims no evidence at all.
- **The Issue Key.** An override is re-tallied against the bucket it moves to before anything is
  written: the target may already hold time the row knew nothing about, and sizing the write from the
  plan's own numbers would log that time twice.

Unplaced hours name the directories their sessions ran in, and mapping one to an Issue Key writes a
Standing Attribution into `~/.jcf/config.json`. Nothing is logged by that action — reload the week
and those hours arrive as an ordinary proposal. A Standing Attribution loses to a branch or a path,
so it can only ever add attribution, never redirect work that was already placed correctly.

## Safety

- Loopback only, one process, one operator. A read needs the session cookie; a write needs the
  cookie, a matching origin, and the CSRF token this tab holds.
- A confirmation names a row of a plan the server still holds and carries no evidence of its own, so
  a browser cannot post its own spans or its own credited seconds.
- Every write re-reads what Jira and Clockify hold at that moment and writes the difference, so
  confirming the same row twice writes once — the same live-state subtraction that makes the CLI safe
  to run out of curiosity. Nothing is remembered about what was declined.
- Nothing is ever modified or deleted in either system. Reconciliation only adds.
