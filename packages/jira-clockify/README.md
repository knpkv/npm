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

`--agent claude` is for time _neither_ side recorded: it reads the Claude Code transcripts under your
session roots — and only those — works out which issue each
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
because both would otherwise derive the same gap and write it twice. Each watch signs the lease it
takes, so one that gets displaced — by a long look running past its own expiry, say — finds out at
its next look and stands down rather than writing alongside the watch that replaced it. If the lease
cannot be written at all, the watch refuses to start: an unwritable config directory means nothing
would stop a second one. That is machine-local: two watches on two machines against one Clockify
account is not something this can see. Nothing is remembered between looks — a proposal is always the
gap the two sides still have — so a failed write, a closed laptop, or a restart costs nothing but a
delay. If Jira rejects the login it stops rather than logging to Clockify alone all afternoon; the
half-written block stays behind the cursor, so logging back in and restarting finishes it rather than
skipping it.

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
