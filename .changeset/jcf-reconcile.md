---
"@knpkv/jira-clockify": minor
---

Add `jcf reconcile` to compare Clockify time against Jira worklogs over a period and fill the gaps. Work is bucketed per ticket per local day and summed on each side, so entries split across either system don't read as discrepancies. Pick a direction — `clockify-to-jira` (default) or `jira-to-clockify` — to choose which side is the source of truth; the command reports every bucket with its delta, then prompts to apply each missing slice into the under-logged side (it only ever adds, never deletes, and posts the delta so re-runs converge). Period flags: `--day` (default), `--week` (last 7 days), or a custom `--since`/`--until` window.
