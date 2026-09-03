# @knpkv/herdr-work

Durable fleet work checkpoints and the Rly departure-board projection used by the Herdr control surface.

Each `WorkGoalCheckpoint` stores a complete, Schema-decoded goal state at its exact durable timestamp. `projectWorkSnapshots` selects the latest recorded checkpoint at now, 24 hours, 7 days, and 30 days. A goal does not appear before its creation checkpoint, and missing history is never synthesized.

`WorkGoal.goalFamily` records a goal as either the canonical member of a family or a superseded member pointing to that canonical goal. Superseded goals leave the active projection only after their durable relation checkpoint. Earlier snapshots still show their previous state, blockers, reviews, and activity. A relation cannot be removed or retargeted, and a superseded goal cannot precede its canonical member.

`WorkStore` persists events in SQLite. Recording the exact same checkpoint again is an idempotent replay; reusing an event ID or goal timestamp with changed content returns `WorkCheckpointConflictError`. `makeWorkService` is the small runtime interface for recording checkpoints and reading all four snapshots.

`WorkBoard` renders these persisted outbound-link forms:

- `AgentConnectTarget.url` — local terminal handoff.
- `WorkApprovalTarget` — approval deep link with its host and job identity. The approvals ingestion boundary resolves the configured destination and verifies the URL origin before persistence; the root path and identity query remain required.
- `WorkReview.url` — review destination.

Every URL uses the credential-free HTTP(S) `LinkUrl` boundary. Provider credentials and private locators never enter these persisted or browser-visible links.

`WorkBoard` accepts `externalLinks="enabled"` by default. With `externalLinks="disabled"`, it keeps recorded approval, review, and Connect targets visible as metadata without rendering outbound links for read-only LAN Work.
