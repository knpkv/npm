# @knpkv/herdr-work

Durable fleet work checkpoints and the Rly departure-board projection used by the Herdr control surface.

Each `WorkGoalCheckpoint` stores a complete, Schema-decoded goal state at its exact durable timestamp. `projectWorkSnapshots` selects the latest recorded checkpoint at now, 24 hours, 7 days, and 30 days. A goal does not appear before its creation checkpoint, and missing history is never synthesized.

`WorkStore` persists events in SQLite. `makeWorkService` is the small runtime interface for recording checkpoints and reading all four snapshots. `WorkBoard` renders the projection and links only through the persisted `AgentConnectTarget`.
