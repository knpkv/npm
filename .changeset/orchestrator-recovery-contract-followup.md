---
"@knpkv/herdr-approvals": minor
"@knpkv/herdr-coordinator": minor
"@knpkv/herdr-fleet": minor
"@knpkv/herdr-work": minor
---

Harden every durable execution read against command, route, activity-key, linked-parent, orphan-replica, and running-worker binding mismatches before restoring Work authority.

Add exact-worker recovery replay, queued delivery failure, accepted Work revision and bounded context handoffs, a required `transition_summary` delegate mode, and a typed failed-Luna Sol escalation reference for durable hostd adapters. Preserve valid subset lineages during v1 migration, reject duplicate dispatch replicas and unsupported or malformed persisted handoff versions, validate the complete persisted worker binding, its immutable lane/checkpoint companions, matching handoff goal, exact routed-metadata discriminator, linked terminally failed Luna parent, and complete coordinator lifecycle before restoring revision authority, and validate current v2 dispatch and metadata replicas against the same handoff before readback. Reject partial coordinator schemas before either v1 or v2 handoff readback, enforce migrated decision capacity after every legacy upgrade path, and expose stale Sol acceptance as `OrchestratorWorkRevisionConflictError` without a partial dispatch. Routed submissions and durable readback bind `consult` to Luna medium, `transition_summary` to Luna low, and `review` or `work` to Sol high, rejecting persisted command/route mismatches before restoring Work authority. Sol escalation accepts only explicit channel-free `review` and `work` agent-delegate commands. Fleet requires exact persisted-worker replay before recovery can report a terminal result and accepts relationship-free coordinator roots only for consultation and transition summaries.
