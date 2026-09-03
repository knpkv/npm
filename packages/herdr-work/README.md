# @knpkv/herdr-work

Durable fleet work checkpoints and the Rly departure-board projection used by the Herdr control surface.

Each `WorkGoalCheckpoint` stores a complete, Schema-decoded goal state at its exact durable timestamp. `projectWorkSnapshots` selects the latest recorded checkpoint at now, 24 hours, 7 days, and 30 days. A goal does not appear before its creation checkpoint, and missing history is never synthesized.

`WorkGoal.goalFamily` records a goal as either the canonical member of a family or a superseded member pointing to that canonical goal. Superseded goals leave the active projection only after their durable relation checkpoint. Earlier snapshots still show their previous state, blockers, reviews, and activity. A relation cannot be removed or retargeted, and a superseded goal cannot precede its canonical member.

`WorkStore` persists events in SQLite. Recording the exact same checkpoint again is an idempotent replay; reusing an event ID or goal timestamp with changed content returns `WorkCheckpointConflictError`. `makeWorkService` is the small runtime interface for recording checkpoints, reading the current durable lane claim, and reading all four snapshots. An unknown lane returns `Option.none()`; a stored claim is Schema-decoded and its revision is checked against the durable row.

`WorkStore.appendMany` validates a whole checkpoint batch before one SQLite
transaction. Reusing its transaction ID with the same batch replays it. A
changed event with an existing event ID or goal/timestamp returns
`WorkCheckpointConflictError`; a different batch that passes those checkpoint
identity checks returns `WorkTransactionConflictError`. `claim` is a durable
compare-and-set lane claim containing the canonical worktree, branch, exact
head, owner, parent, phase, and expected revision. `handoff` stores a compact,
credential-free decision record for later recovery under a 16,384-row and
2 MiB encoded-byte ledger. Replay aliases retain fixed-size canonical SHA-256
identities under a bounded ledger, and lane claims validate Git branch refs
before persisting their authority.

`WorkBoard` renders these persisted outbound-link forms:

- `AgentConnectTarget.url` — local terminal handoff.
- `WorkApprovalTarget` — approval deep link with its host and job identity. The approvals ingestion boundary resolves the configured destination and verifies the URL origin before persistence; the root path and identity query remain required.
- `WorkReview.url` — review destination.

Every URL uses the credential-free HTTP(S) `LinkUrl` boundary. Provider credentials and private locators never enter these persisted or browser-visible links.

`WorkBoard` accepts `externalLinks="enabled"` by default. With `externalLinks="disabled"`, it keeps recorded approval, review, and Connect targets visible as metadata without rendering outbound links for read-only LAN Work.
