---
"@knpkv/herdr-approvals": minor
"@knpkv/herdr-coordinator": minor
"@knpkv/herdr-fleet": minor
"@knpkv/herdr-work": minor
---

Add exact-worker recovery replay, queued delivery failure, accepted Work revision and bounded context handoffs, and a typed failed-Luna Sol escalation reference for durable hostd adapters. Preserve valid subset lineages during v1 migration, validate the complete persisted worker binding before restoring revision authority, and expose stale Sol acceptance as `OrchestratorWorkRevisionConflictError` without a partial dispatch.
