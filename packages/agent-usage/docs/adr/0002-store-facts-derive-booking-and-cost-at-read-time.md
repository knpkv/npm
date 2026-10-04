# Store facts; derive Booking and cost at read time

A Usage Event stores token counts and Attribution Inputs, not its Booking or its API-Equivalent Cost. Both are derived by pure functions when read. Pruned transcripts cannot be re-ingested, so anything computed at ingest would freeze: a sharper ticket rule or a newly priced model would never reach old events. The consequence is deliberate: a price change reprices all history, and the UI says it shows current list price.

## Amendment: Known Projects gate the Active Ticket

Typed text names ticket-shaped strings that are not tickets (`GPT-6`, `SHA-256`, `CVE-2026`). An Active Ticket now counts only when its project is a Known Project: one some branch or worktree path in the store names, or one listed in `AGENT_USAGE_PROJECTS`. Otherwise the event books to its repo and the page lists the ignored prefixes with their request counts. The Known Projects are derived on every read from the stored Attribution Inputs, so this rule, like the rest, reaches events already recorded. Jira lookups were rejected as the gate: a machine without `acli` would book differently from one with it.

## Amendment: limit history is stored raw and compressed when read

Limit Snapshots and Balance Readings are stored as observed and compressed into steps when read, because rollouts arrive file by file and compressing at write time lost readings a later file needed. The one write-side bound is the Codex reader keeping an unchanged reading at most every 10 minutes per rollout (every change, every Unknown and every Claude poll are kept), so across interleaved rollouts a change back can land at most 10 minutes late.
