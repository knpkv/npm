---
"@knpkv/herdr-fleet": minor
"@knpkv/herdr-hub": minor
---

Codex agents waiting on a sleep call now show as waiting, and Codex orchestration wrappers whose commands Codex itself typed as reads, searches or listings show as reading. `AgentTaskFacts` activity gains a `wait` kind. Other wrappers still show as unknown, because Codex types no test, build, write or version-control commands.
