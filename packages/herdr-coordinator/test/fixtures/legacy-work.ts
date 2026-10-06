/**
 * Legacy Work database files for migration tests. Each writer builds a file the
 * way an older release left it, so a test can copy it and open the copy with
 * `WorkStore.open` or the SQL bridge. Writers seed many rows inside one
 * transaction: a file-backed autocommit insert syncs the file once per row.
 */
import { AgentWorkerIdentity } from "@knpkv/herdr-fleet/model"
import { WorkAgentBinding, WorkLaneClaimed } from "@knpkv/herdr-work"
import { Schema } from "effect"
import type { DatabaseSync } from "node:sqlite"

export const startedWorker = Schema.decodeUnknownSync(AgentWorkerIdentity)({
  agentId: "agent-package-worker",
  host: "SER8",
  name: "Package worker",
  paneId: "wE:p3"
})

/** Builds the agent binding a coordinator recorded for `lane` at `occurredAt`. */
export const migrationBinding = (
  dispatchRequestId: string,
  lane: WorkLaneClaimed,
  occurredAt: number
): WorkAgentBinding =>
  Schema.decodeUnknownSync(WorkAgentBinding)({
    checkpoint: {
      eventId: dispatchRequestId,
      goal: {
        agentHierarchy: { agent: startedWorker },
        blocker: null,
        connectTarget: {
          agentId: startedWorker.agentId,
          host: startedWorker.host,
          url: `/connect/?agent=${startedWorker.agentId}&host=${startedWorker.host}`
        },
        createdAt: 0,
        delivery: "local",
        detail: "Migration authority",
        id: lane.goalId,
        owner: lane.owner,
        repository: { branch: lane.branch, repository: "npm" },
        spend: null,
        state: "working",
        summary: "Migration authority",
        title: lane.goalId,
        updatedAt: occurredAt
      },
      occurredAt,
      version: "herdr.work.event.v1"
    },
    lane,
    request: {
      dispatchRequestId,
      expectedRevision: lane.expectedRevision,
      laneId: lane.laneId,
      version: "herdr.work.agent-binding-request.v1",
      worker: startedWorker
    },
    version: "herdr.work.agent-binding.v1"
  })

/** Writes the goal event and lane operation a binding points at. */
export const persistMigrationBindingCompanions = (
  database: DatabaseSync,
  binding: WorkAgentBinding
): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS work_goal_events (
      event_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, occurred_at INTEGER NOT NULL,
      record TEXT NOT NULL, transaction_id TEXT, UNIQUE (goal_id, occurred_at)
    );
    CREATE TABLE IF NOT EXISTS work_lane_operations (
      operation_id TEXT PRIMARY KEY, lane_id TEXT NOT NULL, goal_id TEXT NOT NULL,
      phase TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL
    );
  `)
  database.prepare("INSERT INTO work_goal_events (event_id, goal_id, occurred_at, record) VALUES (?, ?, ?, ?)")
    .run(
      binding.checkpoint.eventId,
      binding.checkpoint.goal.id,
      binding.checkpoint.occurredAt,
      JSON.stringify(binding.checkpoint)
    )
  persistMigrationLaneOperation(database, binding.lane)
}

export const persistMigrationLaneOperation = (
  database: DatabaseSync,
  lane: WorkLaneClaimed
): void => {
  database.prepare("INSERT INTO work_lane_operations VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      lane.operationId,
      lane.laneId,
      lane.goalId,
      lane.phase,
      lane.revision,
      JSON.stringify(lane)
    )
}

/** Writes the orchestrator dispatch and its event history up to `status`. */
export const persistMigrationLifecycle = (
  database: DatabaseSync,
  dispatchRequestId: string,
  runningAt: number,
  status: "queued" | "running" | "settled" | "delivery_failed" | "task_failed",
  mode: "consult" | "transition_summary" | "work"
): void => {
  const activityIdempotencyKey = `activity:${dispatchRequestId}`
  const acceptedAt = Math.max(0, runningAt - 2)
  database.exec(`
    CREATE TABLE IF NOT EXISTS orchestrator_dispatches (
      dispatch_request_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
      activity_idempotency_key TEXT NOT NULL, command TEXT NOT NULL,
      accepted_at INTEGER NOT NULL, is_routed INTEGER NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orchestrator_events (
      dispatch_request_id TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL,
      activity_idempotency_key TEXT NOT NULL, occurred_at INTEGER NOT NULL,
      detail TEXT, result TEXT, PRIMARY KEY (dispatch_request_id, sequence)
    );
  `)
  database.prepare("INSERT INTO orchestrator_dispatches VALUES (?, ?, ?, ?, ?, 1, ?)").run(
    dispatchRequestId,
    `idempotency:${dispatchRequestId}`,
    activityIdempotencyKey,
    JSON.stringify({
      activityIdempotencyKey,
      actor: "coordinator",
      kind: "fleet.job",
      payload: { kind: "agent.delegate", mode, prompt: "Migrate", repository: "/repo" }
    }),
    acceptedAt,
    status
  )
  const insert = database.prepare("INSERT INTO orchestrator_events VALUES (?, ?, ?, ?, ?, ?, ?)")
  insert.run(dispatchRequestId, 0, "accepted", activityIdempotencyKey, acceptedAt, null, null)
  insert.run(dispatchRequestId, 1, "queued", activityIdempotencyKey, Math.max(acceptedAt, runningAt - 1), null, null)
  if (status !== "queued") insert.run(dispatchRequestId, 2, "running", activityIdempotencyKey, runningAt, null, null)
  if (status === "settled") {
    insert.run(dispatchRequestId, 3, "settled", activityIdempotencyKey, runningAt + 1, null, "done")
  } else if (status === "delivery_failed" || status === "task_failed") {
    insert.run(dispatchRequestId, 3, status, activityIdempotencyKey, runningAt + 1, "failed", null)
  }
}

/** The Sol route a coordinator stored for a legacy work dispatch. */
export const legacySolRoute = {
  action: "dispatch",
  linkedRequestId: null,
  model: "gpt-5.6-sol",
  protocol: "hostd.coordinator.route.v1",
  reason: "bounded coordination uses Luna",
  reasoningEffort: "high"
}

export const legacyLane = {
  branch: "feat/legacy",
  expectedRevision: 0,
  head: "0123456789012345678901234567890123456789",
  laneId: "goal:legacy",
  owner: { id: "owner:legacy", name: "Legacy owner" },
  parent: null,
  phase: "implementation",
  revision: 1,
  worktree: "/worktrees/legacy"
}

export const legacyHandoff = {
  decision: "handoff",
  goalId: "goal:legacy",
  id: "handoff:legacy",
  laneId: "goal:legacy",
  occurredAt: 1,
  owner: { id: "owner:legacy", name: "Legacy owner" },
  summary: "Legacy coordinator handoff",
  version: "herdr.work.decision.v1"
}

const legacyClaim = (dispatchRequestId: string, goalId: string) =>
  Schema.decodeUnknownSync(WorkLaneClaimed)({
    ...legacyLane,
    goalId,
    operationId: dispatchRequestId
  })

/**
 * The schema before handoffs carried a session (no `session_id` column), with
 * one running Sol dispatch bound to `legacyLane` plus unrelated and
 * unreadable rows a migration must leave alone. Returns that dispatch's binding.
 */
export const writePreV2WorkFile = (database: DatabaseSync): WorkAgentBinding => {
  database.exec("PRAGMA journal_mode = WAL")
  database.exec(`
    CREATE TABLE work_lane_claims (
      lane_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      record TEXT NOT NULL
    );
    CREATE TABLE work_decision_handoffs (
      handoff_id TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      record TEXT NOT NULL
    );
    CREATE TABLE work_dispatch_handoffs (
      dispatch_request_id TEXT PRIMARY KEY,
      handoff_id TEXT NOT NULL UNIQUE,
      lane_id TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      lineage TEXT NOT NULL,
      record TEXT NOT NULL
    );
    CREATE TABLE work_agent_bindings (
      dispatch_request_id TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL,
      expected_revision INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      host TEXT NOT NULL,
      record TEXT NOT NULL
    );
    CREATE TABLE orchestrator_dispatch_metadata (
      dispatch_request_id TEXT PRIMARY KEY,
      route TEXT,
      work_link TEXT
    );
  `)
  database.prepare("INSERT INTO work_lane_claims VALUES (?, ?, ?)")
    .run(legacyLane.laneId, legacyLane.revision, JSON.stringify(legacyLane))
  database.prepare("INSERT INTO work_decision_handoffs VALUES (?, ?, ?, ?)")
    .run(legacyHandoff.id, legacyHandoff.laneId, legacyHandoff.occurredAt, JSON.stringify(legacyHandoff))
  const lineage = ["dispatch:legacy-luna"]
  const binding = migrationBinding(
    "dispatch:legacy-sol",
    legacyClaim("dispatch:legacy-sol", legacyHandoff.goalId),
    legacyHandoff.occurredAt
  )
  persistMigrationBindingCompanions(database, binding)
  database.prepare("INSERT INTO work_goal_events (event_id, goal_id, occurred_at, record) VALUES (?, ?, ?, ?)")
    .run("event:unreferenced", legacyHandoff.goalId, "not-a-timestamp", "not-json")
  database.prepare("INSERT INTO work_lane_operations VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      "operation:unreferenced",
      legacyHandoff.laneId,
      legacyHandoff.goalId,
      binding.lane.phase,
      "not-a-revision",
      "not-json"
    )
  database.prepare("INSERT INTO work_dispatch_handoffs VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      "dispatch:legacy-sol",
      legacyHandoff.id,
      legacyHandoff.laneId,
      legacyHandoff.occurredAt,
      JSON.stringify(lineage),
      JSON.stringify(legacyHandoff)
    )
  database.prepare("INSERT INTO work_agent_bindings VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "dispatch:legacy-sol",
    legacyHandoff.laneId,
    binding.request.expectedRevision,
    binding.lane.revision,
    binding.request.worker.agentId,
    binding.request.worker.host,
    JSON.stringify(binding)
  )
  database.prepare("INSERT INTO work_agent_bindings VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "dispatch:unrelated-binding",
    legacyHandoff.laneId,
    0,
    1,
    "agent:unrelated",
    "SER8",
    "not-json"
  )
  database.prepare("INSERT INTO orchestrator_dispatch_metadata VALUES (?, ?, ?)")
    .run(
      "dispatch:legacy-sol",
      JSON.stringify(legacySolRoute),
      JSON.stringify({ handoff: legacyHandoff, lineage })
    )
  database.prepare("INSERT INTO orchestrator_dispatch_metadata VALUES (?, NULL, NULL)")
    .run("dispatch:unrelated-metadata")
  persistMigrationLifecycle(database, "dispatch:legacy-sol", binding.checkpoint.occurredAt, "running", "work")
  return binding
}

/**
 * Adds `count` running legacy dispatches with 4 KiB handoffs to a pre-v2 file,
 * enough to exceed the decision ledger's byte capacity when migrated.
 */
export const addOversizedLegacyHandoffs = (database: DatabaseSync, count: number): void => {
  database.exec("BEGIN")
  for (let index = 0; index < count; index++) {
    const occurredAt = index + 10
    const handoff = {
      ...legacyHandoff,
      id: `handoff:legacy-capacity:${String(index)}`,
      occurredAt,
      summary: "x".repeat(4_096)
    }
    const dispatchRequestId = `dispatch:legacy-capacity:${String(index)}`
    const dispatchLineage = [`dispatch:legacy-luna:${String(index)}`]
    const binding = migrationBinding(dispatchRequestId, legacyClaim(dispatchRequestId, handoff.goalId), occurredAt)
    persistMigrationBindingCompanions(database, binding)
    database.prepare("INSERT INTO work_decision_handoffs VALUES (?, ?, ?, ?)")
      .run(handoff.id, handoff.laneId, handoff.occurredAt, JSON.stringify(handoff))
    database.prepare("INSERT INTO work_dispatch_handoffs VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        dispatchRequestId,
        handoff.id,
        handoff.laneId,
        handoff.occurredAt,
        JSON.stringify(dispatchLineage),
        JSON.stringify(handoff)
      )
    database.prepare("INSERT INTO work_agent_bindings VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      dispatchRequestId,
      handoff.laneId,
      binding.request.expectedRevision,
      binding.lane.revision,
      binding.request.worker.agentId,
      binding.request.worker.host,
      JSON.stringify(binding)
    )
    database.prepare("INSERT INTO orchestrator_dispatch_metadata VALUES (?, ?, ?)")
      .run(
        dispatchRequestId,
        JSON.stringify(legacySolRoute),
        JSON.stringify({ handoff, lineage: dispatchLineage })
      )
    persistMigrationLifecycle(database, dispatchRequestId, binding.checkpoint.occurredAt, "running", "work")
  }
  database.exec("COMMIT")
}

/** Advances `legacyLane`'s claim one revision past its binding, as a lane that moved on after dispatch. */
export const advanceLegacyClaim = (database: DatabaseSync): void => {
  database.prepare("UPDATE work_lane_claims SET revision = ?, record = ? WHERE lane_id = ?").run(
    legacyLane.revision + 1,
    JSON.stringify({ ...legacyLane, expectedRevision: legacyLane.revision, revision: legacyLane.revision + 1 }),
    legacyLane.laneId
  )
}
