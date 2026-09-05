# @knpkv/herdr-work

Durable fleet work checkpoints and the Rly departure-board projection used by the Herdr control surface.

Each `WorkGoalCheckpoint` stores a complete, Schema-decoded goal state at its exact durable timestamp. `projectWorkSnapshots` selects the latest recorded checkpoint at now, 24 hours, 7 days, and 30 days. A goal does not appear before its creation checkpoint, and missing history is never synthesized.

`WorkGoal.goalFamily` records a goal as either the canonical member of a family or a superseded member pointing to that canonical goal. Superseded goals leave the active projection only after their durable relation checkpoint. Earlier snapshots still show their previous state, blockers, reviews, and activity. A relation cannot be removed or retargeted, and a superseded goal cannot precede its canonical member.

`WorkStore` persists events in SQLite. Recording the exact same checkpoint again is an idempotent replay; reusing an event ID or goal timestamp with changed content returns `WorkCheckpointConflictError`. `makeWorkService` is the small runtime interface for recording checkpoints, reading the current durable lane claim, and reading all four snapshots. A default snapshot atomically reads history with the coordinator-owned agent-binding boundary and observes the later of that logical time and the current clock, so same-tick coordinator checkpoints remain visible without letting an ordinary future checkpoint shift every window; an explicit observation timestamp preserves historical reads. An unknown lane returns `Option.none()`; a stored claim is Schema-decoded and its revision is checked against the durable row.

The store preserves safe caller-owned state-directory modes, but rejects
group- or world-writable POSIX directories and substituted database paths before
opening the authority database.

`WorkStore.appendMany` validates a whole checkpoint batch before one SQLite
transaction. Reusing its transaction ID with the same batch replays it. A
changed event with an existing event ID or goal/timestamp returns
`WorkCheckpointConflictError`; a different batch that passes those checkpoint
identity checks returns `WorkTransactionConflictError`. `claim` is a durable
compare-and-set lane claim containing the canonical worktree, branch, exact
head, owner, parent, phase, authoritative goal ID, operation ID, and expected
revision. The operation ID replays only its exact committed claim; changed
content conflicts. Its replay ledger is bounded to 16,384 operations and 2 MiB
of encoded records while retaining accepted operation identities. A partial
unique index transactionally permits only one non-shipped lane per goal.
`activeGoalClaim` reads that authority directly.

`bindAgent` is the replay-safe worker-start operation. Its typed request is
keyed by dispatch request ID and carries the exact lane plus expected revision.
One SQLite transaction compare-and-sets that lane, stores the full
`AgentWorkerIdentity`, derives the canonical `AgentConnectTarget`, and appends
the matching goal checkpoint. Exact replay returns the original binding after
restart; changed worker content returns `WorkAgentBindingConflictError`.
Missing, stale, shipped, or terminal goal authority fails without a partial
lane, checkpoint, or binding write.

`handoff` stores a compact, credential-free decision record keyed by coordinator
session ID for later recovery under a 16,384-row and 2 MiB encoded-byte ledger.
It includes the active goal and lane, dispatch IDs, blocker details, evidence
references, and a nonempty credential-free context delta bounded to 4,096
characters. A new v2 handoff captures the active lane's exact expected revision
and rejects a stale revision with `WorkDecisionRevisionConflictError`; exact
replay remains available after that lane advances.
Both the previous pre-session table and v1 records already stored in the current
table migrate explicitly: their bounded summary becomes the v2 context delta.
Migration requires exactly one persisted dispatch binding and keeps that
binding's expected revision; an unbound v1 handoff cannot borrow the current
lane revision, and the persisted lane head cannot trail the binding's activated
revision. The complete `WorkAgentBinding` record must decode and match its
indexed dispatch, lane, revision, worker, and host, plus its exact immutable
lane-operation and checkpoint ledger companions, before migration uses that
authority. A dispatch lineage may remain a strict subset of the decision's
complete dispatch IDs, while the dispatch and coordinator-metadata lineage
replicas must agree exactly. Missing lanes, bindings, dispatch replicas, or
coordinator metadata, malformed records that claim the v1 contract, and contradictory replicas, fail startup with a named
`WorkStoreError`; no context or revision authority is invented.
Coordinator-backed migration and current v2 readback additionally require a complete bounded lifecycle,
the exact running checkpoint, status/tail agreement, a matching handoff goal, and
a schema-valid Sol route whose metadata agrees with the persisted routed
discriminator. A Sol route also requires a persisted `agent.delegate` command in
`review` or `work` mode; the command, route, and Work link are one authority
binding. A non-null Sol link must remain in lineage and identify an exact
terminally failed Luna parent with its own complete lifecycle. Duplicate
pre-session dispatch replicas fail closed. Current v2 readback also decodes the
authoritative lane claim and rejects a lane head older than the activated
binding. Luna metadata must retain a null Work link and does not consume the
bounded Work-decision scan; malformed or non-null Luna links fail closed. Every
modern routed dispatch must retain exactly one metadata row. Standalone Work
databases with no coordinator tables remain valid; a partial coordinator table set fails before
either v1 migration or v2 handoff readback. The SQL adapter creates or upgrades
Work tables in that same fail-closed transaction and ignores unrelated legacy
binding or unrouted metadata rows. Current v2 dispatch and metadata
replicas must decode and agree exactly with the authoritative decision handoff;
dispatch lineage may remain a strict subset of the decision's dispatch set.
Changed content for the same session
conflicts, and `coordinatorHandoff` proves restart readback without retaining an
unbounded transcript. Replay aliases retain fixed-size canonical SHA-256
identities under a bounded ledger, and lane claims validate Git branch refs
before persisting their authority.

`makeSqliteWorkBridge`, exported from the headless `@knpkv/herdr-work/sql`
subpath, provides the SQLite-specific dispatch binding used by a coordinator's
transaction. It inserts the decoded Work handoff and its
bounded dispatch lineage together, and verifies exact replay without repairing
an incomplete dispatch, including the referenced decision row. Every lineage
request must appear in the handoff's dispatch IDs. New bindings require the
handoff's active, non-shipped lane, authoritative goal, and accepted expected revision; exact
binding replay remains available after the lane advances. The coordinator must call it inside the same
transaction as acceptance; `WorkStore.decisions` then recovers the handoff from
the same database. The server-private durable `AgentWorkerIdentity` record stays
behind the Work service boundary. Its derived, normalized client-visible
`AgentConnectTarget` excludes provider credentials and private locators and may
cross only the authenticated Work UI boundary; neither form may be emitted on
unauthenticated or public surfaces.
The same bridge exposes the transaction-owned agent-binding primitive used by
the coordinator's durable `workerStarted` boundary; callers cannot repair a
previously partial activation during replay.

`WorkBoard` renders these persisted outbound-link forms:

- `AgentConnectTarget.url` — local terminal handoff.
- `WorkApprovalTarget` — approval deep link with its host and job identity. The approvals ingestion boundary resolves the configured destination and verifies the URL origin before persistence; the root path and identity query remain required.
- `WorkReview.url` — review destination.

Every URL uses the credential-free HTTP(S) `LinkUrl` boundary. Provider credentials and private locators never enter these persisted or browser-visible links.

`WorkBoard` accepts `externalLinks="enabled"` by default. With `externalLinks="disabled"`, it keeps recorded approval, review, and Connect targets visible as metadata without rendering outbound links for read-only LAN Work.
