# `@knpkv/herdr-coordinator`

Persistent chat contracts over the Herdr fleet job protocol.

Ask mode submits an `agent.delegate` consult job. Work mode submits a locally authorized work job and therefore follows the fleet approval policy. Chat turns persist beside their job IDs and history derives current state from the owning host's durable job record. The browser-facing history contains the newest 32 turns in chronological order; older turns remain durable and addressable by job ID.

Coordinator output is newline-delimited `herdr.coordinator.child.v1` lifecycle events. Both events carry the exact fleet job ID and request ID. A `started` event with the exact sanitized worker identity must arrive before the matching `completed` event. Root coordinator identities omit `relationship` and are valid only for coordinator-handled consult or chat jobs. Delegated child identities carry their exact `parentAgentId` and `relation`; ordinary work without that relationship is rejected. Missing, malformed, duplicate, reordered, job-mismatched, or request-mismatched events fail with named lifecycle errors. Terminal transcripts are never accepted as chat replies. Chat history exposes the same persisted worker and canonical Connect target after restart.

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
idempotency keys are persisted with every event. `recover` returns a pull-based
stream that pages running work in bounded batches, marks it `delivery_failed`,
and never retries it implicitly.
`pending` returns the exact typed command records for accepted and queued work
after restart; callers resume those records explicitly. The
route-aware `submitRouted` operation durably records the executable Luna/Sol
route. A Sol submission requires a typed Work handoff and lineage in the same
SQLite transaction; a linked Sol escalation is accepted only when its parent
request lookup proves a terminal Luna failure. `request` returns that complete
validated projection for escalation decisions. The
exported `singleRunnerLayer` composes Effect's SingleRunner with SQL-backed
MessageStorage and a local runner identity; provide an Effect SQL client and
Crypto implementation at the application boundary. Its SQLite layer creates a
0700 state directory and keeps the database, WAL, and shared-memory files at
0600, reapplying those modes after durable writes. The exported SQLite layer
currently supports POSIX paths only and fails closed on Windows until it can
validate private directory ACLs.
