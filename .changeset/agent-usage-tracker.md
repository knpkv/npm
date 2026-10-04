---
"@knpkv/agent-usage": minor
---

Add `@knpkv/agent-usage`: a local service and browser view for Claude and Codex subscription usage. It records every model request from Claude Code transcripts and Codex rollouts into a per-machine SQLite store, books it to the Jira ticket or repo it worked on, and graphs consumption over time, per ticket, and against the 5-hour and weekly limits.
