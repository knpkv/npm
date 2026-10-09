---
"@knpkv/relay": minor
"@knpkv/codecommit-web": minor
---

Relay's event stream gives the dock what it renders without guessing:

- `RunStarted` names the run.
- Every tool call carries a display-safe summary, and a completed write carries its receipt (CodeCommit: the operation id and the pull request's console link).
- `ConfirmationResolved` reports confirmed, declined or expired.
- Snapshot messages have ids.
- The session says whether its runs can be cancelled.
