---
"@knpkv/jira-clockify": patch
---

jcf's commands no longer fall back silently. When `jcf` cannot relaunch its terminal UI under bun, it fails and names the command to run. Missing Clockify setup is recognised by its own error. A project, tag or entry lookup that fails during `timer start`, `status`, `stop` or `edit`, a Jira connection that cannot be read, a browser that cannot be opened, and a watch lease that cannot be saved or removed keep their fallback, now with a warning naming what was skipped.
