---
"@knpkv/jira-clockify": minor
---

Add persisted session-agent settings for Claude or Codex, with optional model and effort validated by a public pure schema. Read the current settings for every attribution and description operation, so changing them needs no restart.

Report the recorded-time stage from the reconciliation engine and read timer exclusions concurrently with recorded time. Accept an optional activity observer on `SessionAttributor.attribute` and forward visible agent text and process status tagged with batch number and count.

Retain attributed credits on the session report, including credits with no current gap or withheld by a running timer, and add `refreshRecordedTime` to recalculate proposals from that evidence without rereading transcripts or calling the agent.

Retain closed Clockify entries without a ticket key as read-only `unlinkedClockify` records; they never become Jira reconciliation candidates.

Add `SavedEntries` to `Headless.layer` for whole-entry updates against a server-retained snapshot, rechecking provider ownership and the current snapshot and distinguishing validation, conflict and provider failures. Carry optional whole-entry metadata on recorded intervals, including exact original bounds and description. Optionally retain `sessionEvidence` with each session's ticket and active intervals, and accept a nullable ticket key on `SessionAttributor.describe` for unkeyed time.
