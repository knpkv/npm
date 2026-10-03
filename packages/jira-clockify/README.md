# @knpkv/jira-clockify

TUI time tracker bridging Jira and Clockify. Start/stop timers on Jira tickets, auto-log worklogs to both services. Includes Neovim integration.

Built with Effect-TS and [@opentui/react](https://github.com/anomalyco/opentui).

## Installation

```bash
pnpm add @knpkv/jira-clockify
```

Or link globally:

```bash
cd packages/jira-clockify && pnpm link --global
```

## Setup

### 1. Jira OAuth

```bash
jcf auth jira create      # Opens Atlassian console — create OAuth 2.0 app
jcf auth jira configure    # Set client ID and secret
jcf auth jira login        # Authenticate via browser
```

### 2. Clockify API Key

```bash
jcf auth clockify setup    # Enter API key from https://app.clockify.me/manage-api-keys
```

### 3. Configure Defaults

```bash
jcf config set project     # Select default Clockify project
jcf config set billable    # Set default billable flag
jcf config set jql <jql>   # Set default JQL filter
jcf config show            # Show current config
jcf config reset           # Reset to defaults
```

### 4. Session Roots (optional)

Only needed for `jcf sync reconcile --agent claude` and `jcf watch claude`. Nothing is read until you
opt a directory in:

```bash
jcf config set session-root ~/dev/work            # Sessions here may become proposed worklogs
jcf config set session-ticket ~/dev/work/docs KEY # Standing ticket for work with no branch
jcf config set idle-cap 300                       # Longest gap still counted as work (seconds)
```

JCF web's Agent settings controls the provider used to attribute and describe session
evidence. `JcfConfig.sessionAgent` defaults to
`{ "provider": "claude", "model": null, "effort": null }`. Choose `claude` or `codex`;
the selected executable must be installed and authenticated. This choice does not
change which session roots are read. Every attribution and description operation
reads the current settings, so changing them does not require restarting JCF.

The pure `@knpkv/jira-clockify/agent/agentSettings.js` export provides the
`SessionAgentSettings` schema and type, `defaultSessionAgentSettings`, and
`agentEfforts(provider)`. Model names must be trimmed, nonblank and at most 200
characters, or `null` for the CLI default. Effort is `null` for the CLI default or
a provider-supported value. Claude supports low, medium, high, xhigh and max;
Codex supports minimal, low, medium, high and xhigh. The selected model must support
the requested effort. Both adapters use prompt-only execution; unsupported Codex
features fail closed before attribution starts.

## CLI Commands

```bash
jcf                        # Launch TUI (or guided setup if not configured)
jcf tui                    # Launch TUI explicitly
jcf timer start [ISSUE-KEY]       # Start timer on a Jira ticket
jcf timer start KEY --ago 15m     # Start backdated by a duration
jcf timer start KEY --since 09:30 # Start backdated to a past time today or ISO timestamp
jcf timer stop                    # Stop timer, log to Clockify + Jira
                                  #   no timer running? offers to add a correction interval instead
jcf timer discard                 # Discard timer (delete Clockify entry, no Jira worklog)
jcf timer log KEY -t 1h30m        # Log past work manually (--date, --at HH:MM, --comment)
jcf timer edit                    # Edit running timer
jcf timer status                  # Show current timer status
jcf issue list [--json]           # List Jira tickets from configured JQL
jcf auth status            # Show auth status for both services
jcf watch claude           # Log Claude Code session time as it happens
```

### Reconciling

```bash
jcf sync reconcile clockify-to-jira        # Fill Jira from Clockify (--day|--week|--since|--until)
jcf sync reconcile jira-to-clockify        # Fill Clockify from Jira
jcf sync reconcile --agent claude             # Propose worklogs from local Claude Code sessions
jcf sync reconcile --agent claude --calendar  # ...with an hour-by-hour grid of when it happened
jcf sync reconcile --agent claude --json      # Reporting only: one JSON value, nothing logged
```

`--agent claude` is for time _neither_ side recorded: it reads Claude Code and Codex transcripts,
keeps work inside your session roots, and works out which issue each
session belongs to and how long it accounts for, subtracts
what Clockify and Jira already hold, and offers each remaining gap for confirmation. Every row shows
the signal behind it — the git branch, the directory path, a standing ticket, or a reading of the
transcript — so a wrong attribution is visible before you accept it. It is a mode switch, not a
direction, so combining it with `clockify-to-jira` is an error.

Worth being exact about what "only those" means, because it is a _local read_ boundary and a
_disclosure_ boundary, and they are not in the same place. Claude names each project directory after
the working directory with the separators flattened, so `/a/b-c` and `/a/b/c` both become `-a-b-c`.
A directory whose name cannot have come from any of your session roots is never opened at all, which
is nearly all of them. One that collides with a root's encoding is opened, and its sessions are
discarded once the working directory inside says they were out of scope. So an out-of-scope session
can be read from disk by jcf; it can never reach a coding agent, a proposal, or either of the two
systems.

Codex rollouts live under `~/.codex/sessions` in creation-date directories. Those names cannot
identify the working project, so JCF decodes their metadata locally before applying session roots
to each stretch of work. Resumed rollouts in older directories remain eligible for the current
week. Large tool payloads are discarded while streaming the file. Current `UserMessage` events
and older `user_message` events count as presence; injected instructions, response-item prompt
copies, compacted history and native subagent rollouts do not. Selecting Claude or Codex as the
matching agent does not restrict which of these two transcript sources is scanned.

Only messages _you typed_ count as presence — the agent's own output, its tool results, and the
prompts it sends its own subagents do not, since they show it was busy rather than that you were
working. On one real day that was 66 events out
of 1641, and the difference between 1h 53m and 3h 51m. A session counts as active between its own
consecutive prompts, gaps longer than the idle cap are
credited to nothing, and any moment you were working on several tickets at once is divided equally
between them — so a day's proposals can never add up to more than that day's wall clock. Time
spent reading and thinking between prompts is therefore under-counted rather than over-counted; a day
with a timer still running is reported but never proposed.

Everything you need to judge a row is on the row itself, in the picker: when the work item started
and ended, the issue summary, its assignee, the attribution signal, what each side already holds, and
how many blocks the total spans. So the number is checkable against your memory of the day rather
than taken on trust, and time credited to someone else's ticket stands out before it is written. Rows
are laid out for your terminal's width; a wider one spends the room on the issue title and the block
times. `--calendar` draws the same evidence as a
grid — one column per minute, one row per hour, only the hours with credited time:

```text
  2026-07-25   # PROJ-5663
        :00  :05  :10  :15  :20  :25  :30  :35  :40  :45  :50  :55
  00h   .................###########################################
  01h   ##########......###################################.....####
        ~~~ 8h with nothing credited
  11h   ........#############.......................................
```

The grid answers _when_ at minute resolution, so a span shorter than a minute still shows as one
cell; the row above it remains the authority on _how much_.

Each entry it writes says what the time went on. The Clockify description and the Jira worklog comment
carry the issue title and one sentence, read off the session's own prompts, describing what was
actually done:

```text
  2026-07-25  PROJ-5663  +2h 35m to both
    Add an endpoint for a caller's own permissions — Read the identity provider's OIDC docs and designed a route returning the applications the caller may open (Reconciled from Claude Agent Session)
    ✓ created Clockify entry
    ✓ posted to Jira
```

The text is printed before it is written, since it lands in two systems other people read. Notes are
asked for only about the rows you confirm, in one batched call. If the coding agent cannot be reached
the entry falls back to the title and its provenance — a missing sentence never costs the write — and
a session whose prompts do not say what was done gets no sentence rather than an invented one.

Session consumption is private to `~/.jcf/source-consumption.v1.json` (owner-only mode). A confirmed
write binds its source block to the returned provider entry ID and account scope; later description
edits, including removal of the source suffix, do not reset its consumed seconds. A complete provider
read still observes genuine duration changes and deletions. The suffix can import a legacy entry on
first read, but text alone does not override an existing ID binding.

The same private file now stores version 3: it also remembers the IDs and original starts of ordinary
entries seen in a newly reviewed forward interval, separately by provider and account. Repeated or
overlapping review can recognize those entries. A new unmarked entry in older coverage or a changed
start for a remembered ID needs manual review; the tool does not infer its origin from a timestamp.
Versions 1 and 2 load without inventing ordinary entries and upgrade only on a successful atomic
write. New Clockify evidence is scoped to the configured endpoint, workspace, and user verified by
that credential. Older Clockify scopes cannot prove the endpoint: affected windows, observations,
pending intents, and bindings remain intact and held for private manual review. Neither switching
the endpoint nor editing a description turns them into a fresh empty account. Jira evidence remains
independent.

First use with earlier unmarked entries fails closed. Review the affected provider/window privately,
back up the ledger, then record the exact reviewed window, provider/account-scoped ordinary entry
IDs and starts, and any recoverable entry-ID bindings in its versioned JSON. If those facts cannot
be recovered, leave the window held; do not guess links or paste account and entry IDs into tickets
or logs. A pending intent means a create may have succeeded before its ID was recorded: verify the provider entry before
resolving it, or leave the window held. Removing the ledger or pending intent is not a safe retry.
On Linux, a lock whose recorded process has ended in the same PID namespace can be recovered under
an exclusive recovery guard. Legacy, unreadable, or uncertain locks and leftover temporary ledger
files still need private manual review; never remove a lock while its holder may be running.

### Watching as you work

```bash
jcf watch claude              # Log settled blocks as they happen (Ctrl-C to stop)
jcf watch claude --dry-run    # Same, printing what it would write instead of writing it
jcf watch claude --interval 60
```

Same evidence, same arithmetic, no picker. It looks every five minutes and writes a block of work
once it has been quiet for one idle cap — six minutes by default — because until then the block can
still grow, and its share of any parallel work can still change. So entries land at natural breaks
rather than a minute at a time, and each says what the time went on exactly as a confirmed row does:

```text
jcf watch claude
  Looking every 5m, from 10:32. A block is written once it has been quiet for 6m.
  Only branch-, path-, and standing-attributed work is written. Earlier work and anything needing review: jcf sync reconcile --agent claude
  11:48  PROJ-5663  +1h 24m to both
    Add OpenTelemetry spans to the ingest worker — Traced the ingest worker end to end and added spans around the batch flush (Reconciled from Claude Agent Session)
    ✓ created Clockify entry
    ✓ posted to Jira
```

It writes only what it can defend without you: blocks placed by a branch name, a worktree path, or a
standing ticket. It never wakes the coding agent to guess at an attribution — a session's ticket does
not change, so asking every five minutes would spend a call to be told the same thing — and time no
deliberate signal places is named on screen and left for `jcf sync reconcile --agent claude`. The
coding agent is woken only to describe a block it is about to write.

It covers time since it started, plus whatever a previous watch had reached but not yet written — it
leaves a cursor behind, so a restart resumes instead of dropping the block it was holding. A
first-ever run has no cursor and reaches back for nothing. Older than that is `reconcile`'s job,
where you see the rows first.

Only one watch writes at a time. A second one tells you who has been running since when and stops,
because both would otherwise derive the same gap and write it twice. The lease is never taken over
while its file exists: a stale-looking timestamp cannot make a read-then-overwrite race safe. After
an ungraceful process death, verify no watch is running and remove `~/.jcf/watch.lease` manually. If
the lease cannot be written at all, the watch refuses to start: an unwritable config directory means
nothing would stop a second one. That is machine-local: two watches on two machines against one
Clockify account is not something this can see. Nothing is remembered between looks — a proposal is always the
gap the two sides still have — so a failed write, a closed laptop, or a restart costs nothing but a
delay. If Jira rejects the login it stops rather than logging to Clockify alone all afternoon; the
half-written block stays behind the cursor, so logging back in and restarting finishes it rather than
skipping it.

JCF web confirmations, manual entries and saved-entry edits use the same machine writer guard. They
are refused while `jcf watch` holds it; a web mutation releases its short-lived guard without writing
a watch resume cursor.

## TUI Keybindings

| Key           | Action                           |
| ------------- | -------------------------------- |
| `j` / `k`     | Navigate ticket list             |
| `s` / `Enter` | Start timer on selected ticket   |
| `x`           | Stop timer (with comment prompt) |
| `d`           | Discard timer                    |
| `l` / `Tab`   | Toggle between timer and tickets |
| `/` / `f`     | Filter tickets                   |
| `r`           | Refresh ticket list              |
| `q`           | Quit                             |
| `Ctrl+C`      | Force quit                       |

## Neovim Plugin

Ships with a Lua plugin in `nvim/lua/jcf/`. Auto-detects Jira issue keys from branch names.
Periodic status polling requires util-linux `flock`; the lock stays attached to
the `jcf` process so closing or killing Neovim cannot start an overlapping poll.
Polling always coordinates through fixed `~/.jcf/poll.lock` and
`~/.jcf/poll.stamp` files beside the CLI-owned `state.json`; a configured
`state_path` changes display reads only.

### lazy.nvim

```lua
{
  dir = "path/to/packages/jira-clockify",
  config = function()
    require("jcf").setup({
      binary = "jcf",                -- path to jcf binary
      auto_detect_branch = true,     -- detect issue key from git branch
      float = { width = 0.8, height = 0.8 },
      poll_interval = 30000,         -- positive integer ms; invalid/non-positive disables polling
    })
  end,
}
```

### Neovim Commands

| Command       | Description                                         |
| ------------- | --------------------------------------------------- |
| `:JcfToggle`  | Toggle jcf floating terminal                        |
| `:JcfStart`   | Start timer (auto-detects branch or opens selector) |
| `:JcfStop`    | Stop timer (opens float for comment)                |
| `:JcfDiscard` | Discard timer                                       |
| `:JcfLog`     | Log past work                                       |
| `:JcfEdit`    | Edit running timer                                  |
| `:JcfStatus`  | Show timer status                                   |

## Config

Stored in `~/.jcf/`:

```
~/.jcf/
├── config.json      # JQL, project, billable defaults, session roots
├── clockify.json    # Clockify API key, workspace, user
├── poll.lock       # Kernel lock held by the active managed poll
├── poll.stamp      # Last managed poll attempt, including failures
└── state.json       # Current timer state and polling authority
```

Jira OAuth credentials stored via `@knpkv/atlassian-common` in `~/.config/atlassian/`.

## License

MIT

### Reusing session evidence

`ReconcileService.proposeFromSessions` retains attributed credits on its report,
including credits that currently have no gap or are withheld by a running timer.
`refreshRecordedTime(period, report)` rereads only the report's selected providers
and running timers, then recalculates proposals from those credits. It does not
read transcripts or call the attribution agent. JCF web uses this after writes;
an explicit full read collects new session evidence.

### Ticket overlap and live matching

With the default 900-second dwell floor, overlapping attributed work is allocated
in sequential blocks of at least fifteen minutes when the stretch permits it.
Tickets share the stretch evenly; if fewer slots fit, the strongest credited
tickets retain them. Mixed stretches reserve unplaced credit before allocating known tickets. Separate
work, idle gaps, wholly unplaced stretches and midnight stay
separate. Short standalone work is never inflated. Setting dwell to zero retains
raw overlap sharing. Proposal blocks and confirmed amounts use the same timeline;
`activeSeconds` retains the original activity duration.

`SessionAttributor.attribute` accepts an optional activity observer. Reconciliation
forwards visible text and process status as `AgentActivity`, tagged with the batch
number and batch count. JCF web streams these events during matching, while the CLI
prints process milestones to stderr. Final matches remain schema-validated.

Closed Clockify entries without a ticket key are retained in the session proposal
report as `unlinkedClockify`. They remain read-only and never become Jira
reconciliation candidates. The web calendar includes them in Clockify totals and
holds the Clockify side of any overlapping proposed block for manual review, without
guessing that the entry consumed that session's time. Jira and nonoverlapping blocks
remain independently writable. Running entries remain outside
totals; their days are excluded from proposals until the timer stops.

### Editing recorded entries

`SavedEntries.layer` is included in `Headless.layer`. Its `update` operation takes a
server-retained `RecordedEntry` snapshot plus new start/end milliseconds and description,
rechecks provider ownership and the current snapshot, and returns the actual saved
entry. `SavedEntryError.reason` distinguishes validation, conflict and provider failures.
Recorded intervals carry optional whole-entry metadata, including exact original
bounds and description, even when the calendar slices an entry at midnight.

Changed times require whole seconds and positive duration. Jira requires at least
60 seconds when changing time; description-only edits can retain shorter legacy time.
Clockify updates preserve project, task, tags, billable state and entry type. Running,
locked and time-off entries are refused; custom-field entries are refused because the
generated API schema cannot safely round-trip their values. Jira time-only updates keep
the original rich comment; changed descriptions become plain paragraphs, replacing
formatting and embeds. Mention and emoji labels are readable in the editor; cards and
media have no plain-text representation. Updates leave
Jira estimates and visibility unchanged. The service serializes local updates, but the
provider APIs offer no atomic protection from external edits between re-read and save.

Session reports optionally retain `sessionEvidence` with each session's ticket and
individual active intervals. This lets web description requests correlate saved time
without another scan. `SessionAttributor.describe` accepts a nullable ticket key for
unkeyed time. Legacy reports without this evidence cannot support precise correlation.
