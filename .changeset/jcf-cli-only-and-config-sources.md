---
"@knpkv/jira-clockify": minor
---

`jcf sync reconcile --agent --only clockify|jira` reconciles one system; an agent run with a system not connected stops before planning instead of writing half a plan. `jcf config show` says when there is no config file and marks default values. An unknown command prints one line naming the nearest command instead of the whole help.
