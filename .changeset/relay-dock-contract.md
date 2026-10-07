---
"@knpkv/relay": minor
---

Relay names each run by the `requestId`s it answers (on the Snapshot and on every run-ending event), cancels only the run a `runId` names, tells a late or repeated confirmation answer whether it was decided, expired or unknown, reports each backend as Unverified, Ready or Unavailable with a one-line fix, and lets a session switch backend from its next turn.
