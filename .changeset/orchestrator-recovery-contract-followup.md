---
"@knpkv/herdr-approvals": minor
"@knpkv/herdr-coordinator": minor
"@knpkv/herdr-fleet": minor
"@knpkv/herdr-work": minor
---

Add exact-worker recovery replay, queued delivery failure, accepted Work revision and bounded context handoffs, a required `transition_summary` delegate mode, and a typed failed-Luna Sol escalation reference for durable hostd adapters. Preserve valid subset lineages during v1 migration, reject duplicate dispatch replicas and unsupported or malformed persisted handoff versions, validate the complete persisted worker binding, its immutable lane/checkpoint companions, and its running lifecycle proof before restoring revision authority, enforce migrated decision capacity after every legacy upgrade path, and expose stale Sol acceptance as `OrchestratorWorkRevisionConflictError` without a partial dispatch. Sol escalation now accepts only explicit `review` and `work` agent-delegate commands.
