---
"@knpkv/jira-clockify": minor
---

Surface _why_ a Jira worklog failed and stop offering pointless retries. The worklog post now reports a typed outcome (`Posted` / `NotLoggedIn` / `Failed{message}`) instead of a bare boolean, so:

- the `jcf stop` CLI and the TUI retry popup show the actual failure reason (HTTP status / Jira error message) instead of a bare `✗`;
- a not-logged-in failure is recognised as unrecoverable — the CLI/TUI show the `jcf auth jira login` hint and suppress the retry affordance rather than looping on a request that can never succeed;
- a transient failure still offers retry, now labelled with the reason.

Also guards the TUI Retry action against a double-keypress that could double-log the worklog.
