---
"@knpkv/jira-clockify": patch
---

`jcf reconcile` (clockify→jira) now uses the Clockify entry's own description as the Jira worklog comment instead of a fixed "Reconciled from Clockify". For a bucket spanning several entries the descriptions are ticket-prefix-stripped, deduped, and joined; it only falls back to the generic note when there's nothing meaningful to carry over.
