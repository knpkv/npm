---
"@knpkv/herdr-approvals": patch
---

`fleetctl submit HOST work.* <json>` says what is wrong with the payload, in one line: each failing field and what it expected, for example `work.abandon payload: goalId: Missing key; reason: Expected string`. The payload's `kind` may be left out; it is the command's own. Before, any problem printed only "work.abandon payload is invalid".
