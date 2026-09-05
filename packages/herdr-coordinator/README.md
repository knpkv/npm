# `@knpkv/herdr-coordinator`

Persistent chat contracts over the Herdr fleet job protocol.

Ask mode submits an `agent.delegate` `consult` job, which adapters project to Luna at medium reasoning effort. Direct Fleet callers use the distinct required `transition_summary` mode for Luna at low effort; coordinator chat never infers that intent from prompt text. Work mode submits a locally authorized `work` job projected to Sol at high effort and therefore follows the fleet approval policy. Status and wait remain non-dispatch operations. Chat turns persist beside their job IDs and history derives current state from the owning host's durable job record. The browser-facing history contains the newest 32 turns in chronological order; older turns remain durable and addressable by job ID.

Coordinator output is newline-delimited `herdr.coordinator.child.v1` lifecycle events. Both events carry the exact fleet job ID and request ID. A `started` event with the exact sanitized worker identity must arrive before the matching `completed` event. Root coordinator identities omit `relationship` and are valid only for coordinator-handled consult, transition-summary, or chat jobs. Review and ordinary work identities must be delegated children carrying their exact `parentAgentId` and `relation`. Missing, malformed, duplicate, reordered, job-mismatched, or request-mismatched events fail with named lifecycle errors. Terminal transcripts are never accepted as chat replies. Chat history exposes the same persisted worker and canonical Connect target after restart.

Browser-safe schemas, including the orchestration command, receipt, and event
contracts, are exported from `@knpkv/herdr-coordinator/model` without loading
the Node runtime.

`ChatHistory` exposes only normalized, client-visible `AgentWorkerIdentity` and
canonical `AgentConnectTarget` values for the matching worker. The durable
`Orchestrator.request` projection is a server-private escalation record: its
command payload, actor, executable route, Work handoff, and dispatch lineage
must stay behind the authorized coordinator boundary. Provider credentials and
private provider locators are never part of either representation.

`Orchestrator` accepts only the typed `fleet.job` command union and returns an
immediate idempotent receipt. The persisted dispatch identity contains both
the caller-supplied `idempotency_key` and the command's
`activity_idempotency_key`; replaying the former requires the complete decoded
command to match, while reusing the latter under another idempotency key is a
conflict. Its durable event stream records `accepted`,
`queued`, `running`, `settled`, `delivery_failed`, and `task_failed`; activity
idempotency keys are persisted with every event. `events(requestId)` first
replays persisted history, then follows the SQLite journal in sequence until it
emits exactly one terminal event. `recover` returns a pull-based
stream that pages running work in bounded batches, marks it `delivery_failed`,
and never retries it implicitly.
`pending` returns the exact typed command records for accepted and queued work
after restart; callers resume those records explicitly. The
route-aware `submitRouted` operation durably records the executable Luna/Sol
route. A Sol submission requires a typed Work handoff and lineage in the same
SQLite transaction; a linked Sol escalation is accepted only when its parent
request lookup proves a terminal Luna failure. Every lineage request must also
appear in the persisted handoff's dispatch IDs. Consumers use
`submitSolEscalation` with `OrchestratorLinkedSolDispatchReference`; the package
fixes the Sol model, high reasoning effort, route protocol, and failed-Luna link
instead of making the adapter rebuild generic route metadata. It accepts only
`review` and `work` agent-delegate commands; consultation and transition-summary
commands remain Luna-only. If the accepted
Work handoff's lane revision becomes stale before Sol acceptance,
`submitSolEscalation` returns `OrchestratorWorkRevisionConflictError` and commits
no dispatch, metadata, or accepted event. `request` returns that complete
validated projection for escalation decisions and revalidates its referenced
Work decision. The package deliberately uses this SQLite journal/outbox seam,
not Effect Cluster. It schedules no automatic activity retry: after restart,
ambiguous running work becomes `delivery_failed` and the caller must reconcile
any external side effect before resubmission. The package does not claim
exactly-once external execution. A queued pre-worker executor failure may call
`failDelivery`; it records the typed terminal `delivery_failed` event without a
synthetic running transition.

Routed Sol work cannot enter `running` through the plain `run` transition.
The Nix consumer calls the exported typed `workerStarted` operation with the
dispatch request ID, Work lane, the exact expected revision persisted in the
accepted handoff, and full
`AgentWorkerIdentity`. That boundary commits the running event together with
the Work lane compare-and-set, `agentHierarchy.agent`, canonical Connect
target, and goal checkpoint in one SQLite transaction. Exact replay survives a
restart; a changed worker, refreshed accepted revision, or stale lane authority
is a typed conflict, never a sequential repair.

`PullRequestEvidenceProvider.exactHeadGateEvidence` accepts no caller-built
evidence object. Its source performs one bounded provider observation, samples
the head before and after that read, and must return the observed head on every
check, thread, and review record. The provider rejects any source-sensitive item
bound to another commit. A changed or unexpected observation head returns
`PullRequestEvidenceStale`; unbound, missing, or duplicated required-check
evidence returns `PullRequestEvidenceInvalid`. Review history retains distinct
provider review IDs, including multiple submissions by one reviewer, and rejects
duplicate IDs.

`sqliteLayer` directly supplies `Orchestrator`. It creates a
0700 state directory and keeps the database, WAL, and shared-memory files at
0600, reapplying those modes after durable writes. The SQLite layer
currently supports POSIX paths only and fails closed on Windows until it can
validate private directory ACLs.
