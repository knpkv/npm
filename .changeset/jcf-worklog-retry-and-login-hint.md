---
"@knpkv/jira-clockify": minor
---

Let users retry a failed Jira worklog after a partial timer stop (Clockify saved, Jira failed) — via a "Retry" action in the TUI result popup and a retry prompt in the `jcf stop` CLI flow. Also fix `jcf start/stop/log <KEY>` reporting "Ticket not found in Jira" when actually not logged in: these now detect the missing Jira login and point to `jcf auth jira login`.
