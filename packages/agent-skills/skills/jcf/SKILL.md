---
name: jcf
description: Use the @knpkv/jira-clockify CLI to track work across Jira and Clockify. Trigger when the user asks an agent to start, stop, discard, edit, inspect, or manually log time for Jira tickets; reconcile Clockify against Jira or recover forgotten time from local Claude Code sessions; configure Jira OAuth or Clockify API access; list current Jira tickets; set default Clockify project, billable flag, or JQL; or launch the jcf TUI.
---

# Jcf

Use the `jcf` binary to manage Jira-backed Clockify timers.

## Preconditions

- Configure both services before timer operations: Jira OAuth and Clockify API key.
- Use `jcf auth status` to check readiness.
- `jcf` uses the shared Jira CLI auth profile store; for multi-site Jira accounts, use `jira auth profiles` and `jira auth use <profile>` before timer operations when the `jira` binary is available. When the `atlassian` binary is available, prefer `atlassian profiles doctor` to confirm that Jira Clockify is using the intended `jira-cli` auth store and `atlassian auth refresh` for expired Jira tokens.
- Timer operations write to Clockify and may write Jira worklogs; confirm ambiguous ticket keys, durations, dates, and comments before running them.
- Use `jcf issue list --json` when an agent needs structured ticket data.

## Setup

```bash
jcf auth status
jcf auth jira create
jcf auth jira configure
jcf auth jira login
jcf auth clockify setup

atlassian profiles doctor
atlassian auth refresh
```

Configure defaults:

```bash
jcf config show
jcf config set project
jcf config set billable
jcf config set jql 'assignee = currentUser() AND status != Done ORDER BY updated DESC'
jcf config reset
```

Configure which directories' Claude Code sessions may become proposed worklogs:

```bash
jcf config set session-root ~/dev/work
jcf config set session-root ~/dev/work --remove
jcf config set session-ticket ~/dev/work/docs PROJ-42
jcf config set idle-cap 300
```

## Timer Commands

Launch the TUI:

```bash
jcf
jcf tui
```

List available Jira tickets:

```bash
jcf issue list
jcf issue list --json
```

Start work:

```bash
jcf timer start PROJ-123
jcf timer start PROJ-123 --ago 15m
jcf timer start PROJ-123 --since 09:30
jcf timer start PROJ-123 --project <clockify-project-id> --billable
```

Stop or discard current work:

```bash
jcf timer status
jcf timer stop
jcf timer stop --project <clockify-project-id> --billable
jcf timer discard
```

Log completed work manually:

```bash
jcf timer log PROJ-123 --time 1h30m
jcf timer log PROJ-123 --time 45m --date 2026-06-24 --at 09:00 --comment "Pairing on release notes"
```

Edit the running timer:

```bash
jcf timer edit
```

## Reconcile Commands

Both forms are remote write commands: they create Clockify entries and Jira worklogs. Never run
either unattended. Confirm the window and the direction (or the agent) with the user first, and
prefer the read-only forms below when gathering information.

Compare the two sides and fill whichever is short:

```bash
jcf sync reconcile clockify-to-jira --day
jcf sync reconcile jira-to-clockify --week
jcf sync reconcile clockify-to-jira --since 2026-07-01 --until 2026-07-07
```

Recover time neither side recorded, using local Claude Code sessions as evidence:

```bash
jcf sync reconcile --agent claude --day
jcf sync reconcile --agent claude --week
jcf sync reconcile --agent claude --json
jcf sync reconcile --agent claude --day --calendar
```

- `--agent` is a mode switch, not a direction. Passing both is a usage error.
- `claude` is the only supported agent; `--agent codex` fails.
- `--agent claude --json` is the read-only form: it writes exactly one JSON value to stdout, sends
  everything human-facing to stderr, and creates no Clockify entry or Jira worklog. Use it to
  inspect proposals before asking the user which to accept.
- Without `--json`, every row needs an interactive confirmation, so this form is unsuitable for
  unattended use.
- Nothing is proposed for a directory outside the configured session roots, and a day with a timer
  still running is reported but never proposed. Stop the timer and re-run to log that day.
- Every picker row names the issue summary and assignee; `--json` carries both as `summary` and
  `assignee`. Rows are not listed above the picker — the picker rows _are_ the report.
- Written entries carry the issue title and an agent-written sentence saying what was done, read off
  the session prompts. Notes are asked for only about confirmed rows, and only when writing, so
  `--json` never spends a call on one. A row still writes when no note can be produced.
- `--calendar` adds an ASCII hour-by-hour grid of when the time was credited. `--json` carries the
  same information as a `spans` array per proposal, plus the issue `summary`.
- `--json` and `--calendar` are agent-mode flags; passing either without `--agent` is a usage error.
- Only messages the user typed count towards time; the agent's own output, its tool results, and
  prompts it sends its own subagents do not, so an unattended agent run credits at most the idle cap
  rather than the hour it ran for.
- If Jira cannot be read, the run fails rather than proposing time that may already be logged.
- Time worked on several issues at once is split equally between them, so a row's credited total can
  be lower than the clock ranges beneath it; the report names the active total and the shared amount.
- Each proposal shows the attribution signal behind it (`branch`, `path`, `standing`, `agent`).
  A branch name states intent, not fact: time spent on an unrelated fix while on a ticket branch is
  credited to that branch's ticket, so review the signal before confirming.

## Watch Command

```bash
jcf watch claude              # Runs until interrupted; writes as work settles
jcf watch claude --dry-run    # Prints what it would write, writes nothing
jcf watch claude --interval 60
```

- A long-running remote write command. Only start it when the user explicitly asks for live
  tracking, and say that it will keep writing until they stop it. Do not start it to answer a
  question — it never terminates on its own, so it cannot be used to gather information.
- `--dry-run` is the read-only form, but it still runs forever. To inspect unlogged work, use
  `jcf sync reconcile --agent claude --json` instead.
- It writes only branch-, path-, and standing-attributed blocks. Time only a coding agent could
  place is reported and left for `jcf sync reconcile --agent claude`.
- It writes a block once it has been quiet for one idle cap, so work in progress is never written
  and nothing is ever written twice.
- It covers only time since it started. Earlier work in the same day needs `jcf sync reconcile`.
- It stops itself if Jira rejects the login. Re-authenticate with `jcf auth jira login` and restart.

## Agent Workflow

1. Run `jcf auth status` and `jcf timer status` before changing timer state.
2. Use `jcf issue list --json` to resolve issue keys when the user gives a vague ticket description.
3. Verify the active Jira profile when the user names a Jira site/account or before posting worklogs; `atlassian profiles doctor` shows Jira Clockify as a consumer of the `jira-cli` auth store.
4. Prefer explicit flags for non-interactive work: issue key, duration, date, time, project id, billable flag, and comment.
5. If no timer is running, `jcf timer stop` may offer an interactive correction interval; use `jcf timer log` for deterministic manual logging.
6. To find unlogged work, read `jcf sync reconcile --agent claude --json` first and report the
   proposals to the user; only they should decide which rows to write.
