---
name: jcf
description: Use the @knpkv/jira-clockify CLI to track work across Jira and Clockify. Trigger when the user asks an agent to start, stop, discard, edit, inspect, or manually log time for Jira tickets; configure Jira OAuth or Clockify API access; list current Jira tickets; set default Clockify project, billable flag, or JQL; or launch the jcf TUI.
---

# Jcf

Use the `jcf` binary to manage Jira-backed Clockify timers.

## Preconditions

- Configure both services before timer operations: Jira OAuth and Clockify API key.
- Use `jcf auth status` to check readiness.
- `jcf` uses the shared Jira CLI auth profile store; for multi-site Jira accounts, use `jira auth profiles` and `jira auth use <profile>` before timer operations when the `jira` binary is available.
- Timer operations write to Clockify and may write Jira worklogs; confirm ambiguous ticket keys, durations, dates, and comments before running them.
- Use `jcf issue list --json` when an agent needs structured ticket data.

## Setup

```bash
jcf auth status
jcf auth jira create
jcf auth jira configure
jcf auth jira login
jcf auth clockify setup
```

Configure defaults:

```bash
jcf config show
jcf config set project
jcf config set billable
jcf config set jql 'assignee = currentUser() AND status != Done ORDER BY updated DESC'
jcf config reset
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

## Agent Workflow

1. Run `jcf auth status` and `jcf timer status` before changing timer state.
2. Use `jcf issue list --json` to resolve issue keys when the user gives a vague ticket description.
3. Verify the active Jira profile when the user names a Jira site/account or before posting worklogs.
4. Prefer explicit flags for non-interactive work: issue key, duration, date, time, project id, billable flag, and comment.
5. If no timer is running, `jcf timer stop` may offer an interactive correction interval; use `jcf timer log` for deterministic manual logging.
