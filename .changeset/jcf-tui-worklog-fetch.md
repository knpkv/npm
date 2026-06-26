---
"@knpkv/jira-clockify": patch
---

Fix Jira worklog posts failing with a transport error in the TUI. The TUI runs under Bun, where the undici-based HTTP client (used by the raw Jira worklog POST) fails; the CLI runs under Node and was unaffected. Switch the shared HTTP client to the fetch implementation, which works in both Bun and Node — the same fetch the Jira/Clockify API clients already use.
