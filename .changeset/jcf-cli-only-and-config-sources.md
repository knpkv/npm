---
"@knpkv/jira-clockify": minor
"@knpkv/agent-skills": patch
---

`jcf sync reconcile --agent --only clockify|jira` reconciles one system without touching the other, and its `--json` report names what was read in `sides`. An agent run with a system not connected stops before planning instead of writing half a plan. `jcf config show` says when there is no config file and marks default values. An unknown command, at any depth, prints one line naming the nearest command instead of the whole help.
