# @knpkv/herdr-work

Durable fleet work checkpoints and the Rly departure-board projection used by the Herdr control surface.

Each `WorkGoalCheckpoint` stores a complete, Schema-decoded goal state at its exact durable timestamp. `projectWorkSnapshots` selects the latest recorded checkpoint at now, 24 hours, 7 days, and 30 days. A goal does not appear before its creation checkpoint, and missing history is never synthesized.

`WorkStore` persists events in SQLite. Recording the exact same checkpoint again is an idempotent replay; reusing an event ID or goal timestamp with changed content returns `WorkCheckpointConflictError`. `makeWorkService` is the small runtime interface for recording checkpoints and reading all four snapshots. `WorkBoard` renders the projection and exposes three persisted outbound-link forms: `AgentConnectTarget` for local terminal handoff, `WorkApprovalTarget` for an approval deep link carrying its host and job identity, and `WorkReview.url` for the review destination. All URL fields use the credential-free HTTP(S) `LinkUrl` boundary; approval origins are bound to the configured approvals page by `@knpkv/herdr-approvals` before a checkpoint is persisted.
