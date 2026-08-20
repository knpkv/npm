---
"@knpkv/jira-clockify": patch
---

Stop treating an unreadable Jira worklog as an absent one. `jcf sync reconcile` fetches each issue's
worklogs to work out what Jira already holds, and turned any per-issue failure into an empty list —
so one transient Jira error made a bucket look short and offered to fill it, posting hours that were
already there. The read now fails the run and names the issue it failed on.
