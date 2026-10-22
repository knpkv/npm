---
"@knpkv/sandbox-pool": minor
---

A served run now carries its cleaning `reason`, `startedAt`, `endedAt` (null while it runs) and `failedStep` (the step that reported failed, null for a run with none), so a runs page can show reason, duration and start, and a quarantine can name the step that failed. `RunSummary` gains the same `failedStep`.
