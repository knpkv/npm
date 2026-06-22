---
"@knpkv/jira-clockify": minor
---

Add ways to log time when the timer was never started.

- `jcf start KEY --ago <duration>` / `--since <HH:MM|ISO>` backdates the timer
  start to correct a forgotten start.
- `jcf stop` with no running timer now offers to add a **correction interval**:
  pick a ticket, enter a duration and start time, and it writes a completed
  Clockify entry plus the matching Jira worklog.
- `jcf log` gains `--at HH:MM` to set the start time (was hardcoded to 09:00) and
  now resolves project/billable/tags like `start` does.

Internally, the Clockify-entry + Jira-worklog write path is shared via a new
`TimerService.logManual`, and the per-command Jira issue fetch is centralised in
`fetchTicketByKey`.
