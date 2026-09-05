import { Effect, Equal, Schema } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { makeWorkAgentBinding } from "./agent-binding.js"
import {
  WorkAgentBindingAuthorityError,
  WorkAgentBindingConflictError,
  WorkCoordinatorHandoffConflictError,
  WorkDecisionAuthorityConflictError,
  WorkDecisionHandoffConflictError,
  WorkDecisionRevisionConflictError,
  WorkDispatchHandoffConflictError,
  WorkProjectionError,
  WorkStoreError
} from "./errors.js"
import { agentBindingAdmissionError } from "./internal/agent-binding-admission.js"
import {
  AgentBindingGoalEventRow,
  AgentBindingLaneOperationRow,
  agentBindingReadbackError,
  AgentBindingRow,
  decodeAgentBindingGoalEvent,
  decodeAgentBindingRow
} from "./internal/agent-binding-readback.js"
import {
  CoordinatorLifecycleDispatchRow,
  CoordinatorLifecycleEventRow,
  CoordinatorRouteDiscriminatorRow,
  type CoordinatorRouteStorageAuthority,
  requireCoordinatorFailedLunaAuthority,
  requireCoordinatorLifecycleAuthority,
  requireCoordinatorRouteAuthority
} from "./internal/coordinator-authority.js"
import {
  decodePreviousDecisionHandoff,
  previousDecisionHandoffEquivalent,
  PreviousWorkDecisionHandoff,
  upgradePreviousDecisionHandoff,
  workDispatchLineageContainedBy,
  workDispatchLineageEquivalent
} from "./internal/decision-handoff-migration.js"
import {
  WorkAgentBinding,
  type WorkAgentBinding as WorkAgentBindingType,
  WorkAgentBindingRequest,
  type WorkAgentBindingRequest as WorkAgentBindingRequestType,
  WorkDecisionHandoff,
  type WorkDecisionHandoff as WorkDecisionHandoffType,
  WorkDispatchHandoff,
  type WorkDispatchHandoff as WorkDispatchHandoffType,
  WorkGoalCheckpoint,
  workHistoryMaxEvents,
  WorkLaneClaimed,
  workSnapshotMaxGoals
} from "./model.js"

const DecisionRow = Schema.Struct({
  handoffId: Schema.String,
  sessionId: Schema.String,
  laneId: Schema.String,
  occurredAt: Schema.Number,
  record: Schema.String
})
const DispatchHandoffRow = Schema.Struct({
  dispatchRequestId: Schema.String,
  handoffId: Schema.String,
  laneId: Schema.String,
  occurredAt: Schema.Number,
  lineage: Schema.String,
  record: Schema.String
})
const LaneOperationLedgerTotalsRow = Schema.Struct({
  operationBytes: Schema.Number,
  operationCount: Schema.Number
})
const DecisionLedgerTotalsRow = Schema.Struct({
  decisionBytes: Schema.Number,
  decisionCount: Schema.Number
})
const LaneRow = Schema.Struct({
  goalId: Schema.String,
  laneId: Schema.String,
  operationId: Schema.String,
  phase: Schema.String,
  record: Schema.String,
  revision: Schema.Number
})
const SqliteColumnRow = Schema.Struct({ name: Schema.String })
const LegacyDecisionRow = Schema.Struct({
  handoffId: Schema.String,
  laneId: Schema.String,
  occurredAt: Schema.Number,
  record: Schema.String
})
const LegacyDecisionRecord = Schema.Struct({
  version: Schema.Literal("herdr.work.decision.v1"),
  id: Schema.String,
  laneId: Schema.String,
  goalId: Schema.String,
  decision: Schema.String,
  summary: Schema.String,
  owner: Schema.Struct({ id: Schema.String, name: Schema.String }),
  occurredAt: Schema.Number
})
const LegacyLaneRow = Schema.Struct({ laneId: Schema.String, revision: Schema.Number, record: Schema.String })
const LegacyLaneRecord = Schema.Struct({
  laneId: Schema.String,
  worktree: Schema.String,
  branch: Schema.String,
  head: Schema.String,
  owner: Schema.Struct({ id: Schema.String, name: Schema.String }),
  parent: Schema.NullOr(Schema.String),
  phase: Schema.String,
  expectedRevision: Schema.Number,
  revision: Schema.Number
})
const LegacyDispatchRow = Schema.Struct({
  dispatchRequestId: Schema.String,
  handoffId: Schema.String,
  laneId: Schema.String,
  occurredAt: Schema.Number,
  lineage: Schema.String,
  record: Schema.String
})
const SqliteTableRow = Schema.Struct({ name: Schema.String })
const LaneRevisionRow = Schema.Struct({ revision: Schema.Number })
const MetadataWorkLinkRow = Schema.Struct({
  dispatchRequestId: Schema.String,
  route: Schema.String,
  workLink: Schema.NullOr(Schema.String)
})
const PreviousMetadataWorkLink = Schema.Struct({
  handoff: PreviousWorkDecisionHandoff,
  lineage: WorkDispatchHandoff.fields.lineage
})
const LegacyMetadataWorkLink = Schema.Struct({
  handoff: LegacyDecisionRecord,
  lineage: WorkDispatchHandoff.fields.lineage
})
const legacyDecisionEquivalent = Schema.toEquivalence(LegacyDecisionRecord)

const workDecisionMaxRecords = 16_384
const workDecisionMaxBytes = 2 * 1024 * 1024
const utf8 = new TextEncoder()
const storeError = (operation: string) => (cause: unknown) => new WorkStoreError({ cause, operation })

const encodedBytes = (value: string): number => utf8.encode(value).byteLength

const decodeLegacyLane = (row: typeof LegacyLaneRow.Type) =>
  Effect.try({
    try: () => {
      const legacy = Schema.decodeUnknownSync(LegacyLaneRecord)(JSON.parse(row.record))
      if (legacy.laneId !== row.laneId || legacy.revision !== row.revision) {
        throw new WorkStoreError({ cause: { legacy, row }, operation: "sql-work.migrate.lane-identity" })
      }
      return Schema.decodeUnknownSync(WorkLaneClaimed)({
        ...legacy,
        goalId: legacy.laneId,
        operationId: legacy.laneId
      })
    },
    catch: storeError("sql-work.initialize.decode-legacy-lane")
  })

const decodeLegacyDecision = (
  bindingRows: ReadonlyArray<typeof AgentBindingRow.Type>,
  bindingLaneRows: ReadonlyArray<typeof AgentBindingLaneOperationRow.Type>,
  bindingCheckpointRows: ReadonlyArray<typeof AgentBindingGoalEventRow.Type>,
  dispatches: ReadonlyArray<typeof LegacyDispatchRow.Type>,
  lanes: ReadonlyArray<WorkLaneClaimed>,
  metadataTablePresent: boolean,
  metadataRows: ReadonlyArray<typeof MetadataWorkLinkRow.Type>,
  row: typeof LegacyDecisionRow.Type
) =>
  Effect.try({
    try: () => {
      const legacy = Schema.decodeUnknownSync(LegacyDecisionRecord)(JSON.parse(row.record))
      if (legacy.id !== row.handoffId || legacy.laneId !== row.laneId || legacy.occurredAt !== row.occurredAt) {
        throw new WorkStoreError({ cause: { legacy, row }, operation: "sql-work.migrate.identity" })
      }
      const matchingDispatches = dispatches.filter(({ handoffId }) => handoffId === legacy.id)
      const dispatch = matchingDispatches[0]
      const dispatchIds = dispatch === undefined
        ? []
        : Schema.decodeUnknownSync(WorkDispatchHandoff.fields.lineage)(JSON.parse(dispatch.lineage))
      const lane = lanes.find(({ laneId }) => laneId === legacy.laneId)
      if (lane === undefined) {
        throw new WorkStoreError({ cause: legacy, operation: "sql-work.migrate.handoff-lane" })
      }
      if (matchingDispatches.length !== 1 || dispatch === undefined) {
        throw new WorkStoreError({
          cause: { legacy, matchingDispatches },
          operation: "sql-work.migrate.legacy-dispatch-cardinality"
        })
      }
      const dispatchHandoff = Schema.decodeUnknownSync(LegacyDecisionRecord)(JSON.parse(dispatch.record))
      if (
        dispatch.laneId !== legacy.laneId || dispatch.occurredAt !== legacy.occurredAt ||
        !legacyDecisionEquivalent(dispatchHandoff, legacy)
      ) {
        throw new WorkStoreError({
          cause: { dispatch, dispatchHandoff, legacy },
          operation: "sql-work.migrate.legacy-dispatch-authority"
        })
      }
      if (metadataTablePresent) {
        const matchingMetadata = metadataRows.filter(({ dispatchRequestId }) =>
          dispatchRequestId === dispatch.dispatchRequestId
        )
        const metadata = matchingMetadata[0]
        if (matchingMetadata.length !== 1 || metadata?.workLink === null || metadata?.workLink === undefined) {
          throw new WorkStoreError({
            cause: { dispatch, matchingMetadata },
            operation: "sql-work.migrate.legacy-metadata-authority"
          })
        }
        const workLink = Schema.decodeUnknownSync(LegacyMetadataWorkLink)(JSON.parse(metadata.workLink))
        if (
          !legacyDecisionEquivalent(workLink.handoff, legacy) ||
          !workDispatchLineageEquivalent(workLink.lineage, dispatchIds)
        ) {
          throw new WorkStoreError({
            cause: { legacy, workLink },
            operation: "sql-work.migrate.legacy-metadata-authority"
          })
        }
      }
      const matchingBindings = bindingRows.filter(({ dispatchRequestId }) =>
        dispatchRequestId === dispatch.dispatchRequestId
      )
      const bindingRow = matchingBindings[0]
      if (matchingBindings.length !== 1 || bindingRow === undefined) {
        throw new WorkStoreError({
          cause: { dispatch, legacy, matchingBindings },
          operation: "sql-work.migrate.legacy-handoff-revision"
        })
      }
      const bindingDecision = decodeAgentBindingRow(
        bindingRow,
        { dispatchRequestId: dispatch.dispatchRequestId, laneId: legacy.laneId },
        "sql-work.migrate.legacy-agent-binding"
      )
      if (bindingDecision._tag === "invalid") throw bindingDecision.error
      if (bindingDecision.binding.lane.goalId !== legacy.goalId) {
        throw new WorkStoreError({
          cause: { binding: bindingDecision.binding, legacy },
          operation: "sql-work.migrate.legacy-agent-binding.goal"
        })
      }
      const readbackError = agentBindingReadbackError(
        bindingDecision.binding,
        bindingLaneRows.find(({ operationId }) => operationId === bindingDecision.binding.lane.operationId),
        bindingCheckpointRows.find(({ eventId }) => eventId === bindingDecision.binding.checkpoint.eventId),
        "sql-work.migrate.legacy-agent-binding"
      )
      if (readbackError !== undefined) throw readbackError
      return Schema.decodeUnknownSync(WorkDecisionHandoff)({
        ...legacy,
        contextDelta: legacy.summary,
        expectedRevision: bindingDecision.binding.request.expectedRevision,
        sessionId: legacy.id,
        dispatchIds,
        blockers: [],
        evidenceRefs: [],
        version: "herdr.work.decision.v2"
      })
    },
    catch: (cause) =>
      Schema.is(WorkStoreError)(cause)
        ? cause
        : new WorkStoreError({ cause, operation: "sql-work.initialize.decode-legacy-handoff" })
  })

const decodeHandoff = (row: typeof DecisionRow.Type) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(WorkDecisionHandoff)(JSON.parse(row.record)),
    catch: storeError("sql-work.decode-handoff")
  }).pipe(
    Effect.flatMap((handoff) =>
      row.handoffId !== handoff.id ||
        row.sessionId !== handoff.sessionId ||
        row.laneId !== handoff.laneId ||
        row.occurredAt !== handoff.occurredAt
        ? Effect.fail(
          new WorkStoreError({
            cause: { handoff, row },
            operation: "sql-work.decode-handoff.identity-mismatch"
          })
        )
        : Effect.succeed(handoff)
    )
  )

const decodeDispatchHandoff = (row: typeof DispatchHandoffRow.Type) =>
  Effect.try({
    try: () =>
      Schema.decodeUnknownSync(WorkDispatchHandoff)({
        dispatchRequestId: row.dispatchRequestId,
        handoff: JSON.parse(row.record),
        lineage: JSON.parse(row.lineage)
      }),
    catch: storeError("sql-work.decode-dispatch-handoff")
  }).pipe(
    Effect.flatMap((binding) =>
      row.handoffId !== binding.handoff.id ||
        row.laneId !== binding.handoff.laneId ||
        row.occurredAt !== binding.handoff.occurredAt
        ? Effect.fail(
          new WorkStoreError({
            cause: { binding, row },
            operation: "sql-work.decode-dispatch-handoff.identity-mismatch"
          })
        )
        : Effect.succeed(binding)
    )
  )

export interface SqliteWorkBridge {
  /** Creates the Work decision and dispatch-link tables in the caller's SQL database. */
  readonly initialize: Effect.Effect<void, WorkStoreError | SqlError>
  /** Commits the worker identity, goal checkpoint, and lane CAS inside the caller transaction. */
  readonly acceptAgentBinding: (
    request: WorkAgentBindingRequestType,
    occurredAt: number
  ) => Effect.Effect<
    | { readonly _tag: "inserted"; readonly binding: WorkAgentBindingType }
    | { readonly _tag: "replayed"; readonly binding: WorkAgentBindingType },
    | WorkAgentBindingAuthorityError
    | WorkAgentBindingConflictError
    | WorkProjectionError
    | WorkStoreError
    | SqlError
  >
  /** Reads an exact binding for restart replay without repairing a partial activation. */
  readonly requireAgentBinding: (
    request: WorkAgentBindingRequestType
  ) => Effect.Effect<
    WorkAgentBindingType,
    WorkAgentBindingConflictError | WorkStoreError | SqlError
  >
  /** Inserts or replays one binding; the caller owns the surrounding transaction. */
  readonly acceptDispatchHandoff: (
    binding: WorkDispatchHandoffType
  ) => Effect.Effect<
    WorkDispatchHandoffType,
    | WorkCoordinatorHandoffConflictError
    | WorkDecisionAuthorityConflictError
    | WorkDecisionHandoffConflictError
    | WorkDecisionRevisionConflictError
    | WorkDispatchHandoffConflictError
    | WorkProjectionError
    | WorkStoreError
    | SqlError
  >
  /** Verifies a replayed binding without repairing a previously incomplete dispatch. */
  readonly requireDispatchHandoff: (
    binding: WorkDispatchHandoffType
  ) => Effect.Effect<
    WorkDispatchHandoffType,
    WorkDecisionAuthorityConflictError | WorkDispatchHandoffConflictError | WorkStoreError | SqlError
  >
}

/**
 * SQLite-backed Work operations designed to run inside a coordinator transaction.
 * It does not begin or commit a transaction itself, so dispatch acceptance and
 * Work lineage either commit together or roll back together.
 */
export const makeSqliteWorkBridge = (sql: SqlClientService): SqliteWorkBridge => {
  const initialize = Effect.gen(function*() {
    yield* sql`
      CREATE TABLE IF NOT EXISTS work_goal_events (
        event_id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        record TEXT NOT NULL,
        transaction_id TEXT,
        UNIQUE (goal_id, occurred_at)
      )
    `.pipe(Effect.mapError(storeError("sql-work.initialize.goal-events")))
    yield* sql`
      CREATE TABLE IF NOT EXISTS work_agent_bindings (
        dispatch_request_id TEXT PRIMARY KEY,
        lane_id TEXT NOT NULL,
        expected_revision INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        host TEXT NOT NULL,
        record TEXT NOT NULL
      )
    `.pipe(Effect.mapError(storeError("sql-work.initialize.agent-bindings")))
    yield* sql`
      CREATE TABLE IF NOT EXISTS work_lane_claims (
        lane_id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        operation_id TEXT NOT NULL UNIQUE,
        phase TEXT NOT NULL,
        revision INTEGER NOT NULL,
        record TEXT NOT NULL
      )
    `.pipe(Effect.mapError(storeError("sql-work.initialize.lane-claims")))
    yield* sql`
      CREATE TABLE IF NOT EXISTS work_lane_operations (
        operation_id TEXT PRIMARY KEY,
        lane_id TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        revision INTEGER NOT NULL,
        record TEXT NOT NULL
      )
    `.pipe(Effect.mapError(storeError("sql-work.initialize.lane-operations")))
    yield* sql`
      CREATE TABLE IF NOT EXISTS work_lane_operation_totals (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        operation_count INTEGER NOT NULL CHECK (operation_count >= 0),
        operation_bytes INTEGER NOT NULL CHECK (operation_bytes >= 0)
      )
    `.pipe(Effect.mapError(storeError("sql-work.initialize.lane-operation-totals")))
    yield* sql`
      CREATE TABLE IF NOT EXISTS work_decision_handoffs (
        handoff_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        lane_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        record TEXT NOT NULL
      )
    `.pipe(Effect.mapError(storeError("sql-work.initialize.handoffs")))
    yield* sql`
      CREATE TABLE IF NOT EXISTS work_dispatch_handoffs (
        dispatch_request_id TEXT PRIMARY KEY,
        handoff_id TEXT NOT NULL UNIQUE,
        lane_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        lineage TEXT NOT NULL,
        record TEXT NOT NULL,
        FOREIGN KEY (handoff_id) REFERENCES work_decision_handoffs(handoff_id)
      )
    `.pipe(Effect.mapError(storeError("sql-work.initialize.dispatch-links")))
    yield* sql`
      CREATE TABLE IF NOT EXISTS work_decision_totals (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        decision_count INTEGER NOT NULL CHECK (decision_count >= 0),
        decision_bytes INTEGER NOT NULL CHECK (decision_bytes >= 0)
      )
    `.pipe(Effect.mapError(storeError("sql-work.initialize.totals")))
    yield* sql.withTransaction(Effect.gen(function*() {
      const laneColumns = yield* sql`PRAGMA table_info(work_lane_claims)`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SqliteColumnRow))),
        Effect.mapError(storeError("sql-work.initialize.lane-columns"))
      )
      const decisionColumns = yield* sql`PRAGMA table_info(work_decision_handoffs)`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SqliteColumnRow))),
        Effect.mapError(storeError("sql-work.initialize.handoff-columns"))
      )
      const tables = yield* sql`SELECT name FROM sqlite_master WHERE type = 'table'`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SqliteTableRow))),
        Effect.mapError(storeError("sql-work.initialize.tables"))
      )
      const coordinatorTablesPresent = {
        dispatch: tables.some(({ name }) => name === "orchestrator_dispatches"),
        event: tables.some(({ name }) => name === "orchestrator_events"),
        metadata: tables.some(({ name }) => name === "orchestrator_dispatch_metadata")
      }
      const coordinatorDispatchColumns = coordinatorTablesPresent.dispatch
        ? yield* sql`PRAGMA table_info(orchestrator_dispatches)`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SqliteColumnRow))),
          Effect.mapError(storeError("sql-work.initialize.coordinator-dispatch-columns"))
        )
        : []
      const requireCoordinatorSchema = Effect.fn("SqlWork.requireCoordinatorSchema")(function*(
        operation: string
      ) {
        const present = Object.values(coordinatorTablesPresent).filter(Boolean).length
        if (present !== 0 && present !== 3) {
          return yield* new WorkStoreError({
            cause: coordinatorTablesPresent,
            operation: `${operation}.schema`
          })
        }
        return present === 3
      })
      const readCoordinatorLifecycle = Effect.fn("SqlWork.readCoordinatorLifecycle")(function*(
        dispatchRequestId: string,
        operation: string
      ) {
        const dispatchRows = yield* sql`
          SELECT dispatch_request_id AS "dispatchRequestId",
            activity_idempotency_key AS "activityIdempotencyKey", command,
            accepted_at AS "acceptedAt", status
          FROM orchestrator_dispatches WHERE dispatch_request_id = ${dispatchRequestId} LIMIT 2
        `.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(CoordinatorLifecycleDispatchRow))),
          Effect.mapError(storeError(`${operation}.read-dispatch`))
        )
        const eventRows = yield* sql`
          SELECT dispatch_request_id AS "dispatchRequestId", sequence, type,
            activity_idempotency_key AS "activityIdempotencyKey",
            occurred_at AS "occurredAt", detail, result
          FROM orchestrator_events WHERE dispatch_request_id = ${dispatchRequestId}
          ORDER BY sequence ASC LIMIT 5
        `.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(CoordinatorLifecycleEventRow))),
          Effect.mapError(storeError(`${operation}.read-events`))
        )
        return { dispatchRows, eventRows }
      })
      const routeStorageAuthority = Effect.fn("SqlWork.routeStorageAuthority")(function*(
        dispatchRequestId: string,
        operation: string
      ) {
        if (!coordinatorDispatchColumns.some(({ name }) => name === "is_routed")) {
          return {
            _tag: "legacy_without_routed_discriminator"
          } satisfies CoordinatorRouteStorageAuthority
        }
        const rows = yield* sql`
          SELECT is_routed AS "isRouted" FROM orchestrator_dispatches
          WHERE dispatch_request_id = ${dispatchRequestId} LIMIT 2
        `.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(CoordinatorRouteDiscriminatorRow))),
          Effect.mapError(storeError(operation))
        )
        const row = rows[0]
        if (rows.length !== 1 || row === undefined) {
          return yield* new WorkStoreError({ cause: { dispatchRequestId, rows }, operation })
        }
        return {
          _tag: "routed_discriminator",
          isRouted: row.isRouted
        } satisfies CoordinatorRouteStorageAuthority
      })
      const requireLinkedParentAuthority = Effect.fn("SqlWork.requireLinkedParentAuthority")(function*(
        linkedRequestId: string | null,
        operation: string
      ) {
        if (linkedRequestId === null) return
        const metadataRows = yield* sql`
          SELECT dispatch_request_id AS "dispatchRequestId", route, work_link AS "workLink"
          FROM orchestrator_dispatch_metadata WHERE dispatch_request_id = ${linkedRequestId} LIMIT 2
        `.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(MetadataWorkLinkRow))),
          Effect.mapError(storeError(operation))
        )
        const metadata = metadataRows[0]
        if (metadataRows.length !== 1 || metadata === undefined || metadata.workLink !== null) {
          return yield* new WorkStoreError({ cause: { linkedRequestId, metadataRows }, operation })
        }
        const lifecycle = yield* readCoordinatorLifecycle(linkedRequestId, operation)
        const storageAuthority = yield* routeStorageAuthority(linkedRequestId, operation)
        yield* Effect.try({
          try: () =>
            requireCoordinatorFailedLunaAuthority(
              lifecycle.dispatchRows,
              lifecycle.eventRows,
              metadata.route,
              storageAuthority,
              operation
            ),
          catch: (cause) => Schema.is(WorkStoreError)(cause) ? cause : new WorkStoreError({ cause, operation })
        })
      })
      const requireMetadataAuthority = Effect.fn("SqlWork.requireMetadataAuthority")(function*(
        dispatchRequestId: string,
        routeText: string,
        lineage: ReadonlyArray<string>,
        operation: string
      ) {
        const storageAuthority = yield* routeStorageAuthority(dispatchRequestId, operation)
        const route = yield* Effect.try({
          try: () => requireCoordinatorRouteAuthority(routeText, lineage, storageAuthority, operation),
          catch: (cause) => Schema.is(WorkStoreError)(cause) ? cause : new WorkStoreError({ cause, operation })
        })
        yield* requireLinkedParentAuthority(route.linkedRequestId, `${operation}.parent`)
      })
      const requireLifecycleAuthority = Effect.fn("SqlWork.requireLifecycleAuthority")(function*(
        dispatchRequestId: string,
        expectedRunningAt: number,
        operation: string
      ) {
        if (!(yield* requireCoordinatorSchema(operation))) return
        const lifecycle = yield* readCoordinatorLifecycle(dispatchRequestId, operation)
        yield* Effect.try({
          try: () =>
            requireCoordinatorLifecycleAuthority(
              lifecycle.dispatchRows,
              lifecycle.eventRows,
              expectedRunningAt,
              operation
            ),
          catch: (cause) => Schema.is(WorkStoreError)(cause) ? cause : new WorkStoreError({ cause, operation })
        })
      })
      const hasLegacyDecisionTable = !decisionColumns.some(({ name }) => name === "session_id")
      const legacyLanes = !laneColumns.some(({ name }) => name === "goal_id")
        ? yield* sql`SELECT lane_id AS "laneId", revision, record FROM work_lane_claims`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(LegacyLaneRow))),
          Effect.flatMap((rows) => Effect.forEach(rows, decodeLegacyLane)),
          Effect.mapError(storeError("sql-work.initialize.legacy-lanes"))
        )
        : []
      const legacyDispatches = yield* sql`
      SELECT dispatch_request_id AS "dispatchRequestId", handoff_id AS "handoffId",
        lane_id AS "laneId", occurred_at AS "occurredAt", lineage, record
      FROM work_dispatch_handoffs
    `.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(LegacyDispatchRow))),
        Effect.mapError(storeError("sql-work.initialize.legacy-dispatches"))
      )
      const legacyBindingRows = tables.some(({ name }) => name === "work_agent_bindings")
        ? yield* sql`
          SELECT dispatch_request_id AS "dispatchRequestId", lane_id AS "laneId",
            expected_revision AS "expectedRevision", revision, agent_id AS "agentId", host, record
          FROM work_agent_bindings
        `.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(AgentBindingRow))),
          Effect.mapError(storeError("sql-work.initialize.legacy-binding-rows"))
        )
        : []
      const legacyBindings = yield* Effect.forEach(
        hasLegacyDecisionTable ? legacyBindingRows : [],
        (row) =>
          Effect.gen(function*() {
            const decision = decodeAgentBindingRow(
              row,
              { dispatchRequestId: row.dispatchRequestId, laneId: row.laneId },
              "sql-work.initialize.legacy-agent-binding"
            )
            return decision._tag === "invalid" ? yield* decision.error : decision.binding
          })
      )
      const legacyBindingOperationIds = Array.from(
        new Set(legacyBindings.map(({ lane }) => lane.operationId))
      )
      const legacyBindingEventIds = Array.from(
        new Set(legacyBindings.map(({ checkpoint }) => checkpoint.eventId))
      )
      const legacyBindingLaneRows = tables.some(({ name }) =>
          name === "work_lane_operations"
        ) && legacyBindingOperationIds.length > 0
        ? yield* sql`
          SELECT operation_id AS "operationId", lane_id AS "laneId", goal_id AS "goalId",
            phase, revision, record
          FROM work_lane_operations
          WHERE operation_id IN ${sql.in(legacyBindingOperationIds)}
        `.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(AgentBindingLaneOperationRow))),
          Effect.mapError(storeError("sql-work.initialize.legacy-binding-lane-rows"))
        )
        : []
      const legacyBindingCheckpointRows = tables.some(({ name }) =>
          name === "work_goal_events"
        ) && legacyBindingEventIds.length > 0
        ? yield* sql`
          SELECT event_id AS "eventId", goal_id AS "goalId", occurred_at AS "occurredAt", record
          FROM work_goal_events
          WHERE event_id IN ${sql.in(legacyBindingEventIds)}
        `.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(AgentBindingGoalEventRow))),
          Effect.mapError(storeError("sql-work.initialize.legacy-binding-checkpoint-rows"))
        )
        : []
      const legacyMetadata = tables.some(({ name }) => name === "orchestrator_dispatch_metadata")
        ? yield* sql`
          SELECT dispatch_request_id AS "dispatchRequestId", route, work_link AS "workLink"
          FROM orchestrator_dispatch_metadata
        `.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(MetadataWorkLinkRow))),
          Effect.mapError(storeError("sql-work.initialize.legacy-metadata"))
        )
        : []
      const metadataTablePresent = tables.some(({ name }) => name === "orchestrator_dispatch_metadata")
      const legacyDecisions = hasLegacyDecisionTable
        ? yield* sql`
        SELECT handoff_id AS "handoffId", lane_id AS "laneId", occurred_at AS "occurredAt", record
        FROM work_decision_handoffs
      `.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(LegacyDecisionRow))),
          Effect.mapError(storeError("sql-work.initialize.legacy-handoff-rows")),
          Effect.flatMap((rows) =>
            Effect.forEach(
              rows,
              (row) =>
                decodeLegacyDecision(
                  legacyBindingRows,
                  legacyBindingLaneRows,
                  legacyBindingCheckpointRows,
                  legacyDispatches,
                  legacyLanes,
                  metadataTablePresent,
                  legacyMetadata,
                  row
                )
            )
          )
        )
        : []
      yield* Effect.forEach(legacyDecisions, (handoff) => {
        const dispatch = legacyDispatches.find(({ handoffId }) => handoffId === handoff.id)
        const binding = dispatch === undefined
          ? undefined
          : legacyBindings.find(({ request }) => request.dispatchRequestId === dispatch.dispatchRequestId)
        if (dispatch === undefined || binding === undefined) {
          return Effect.fail(
            new WorkStoreError({
              cause: { binding, dispatch, handoff },
              operation: "sql-work.initialize.legacy-agent-binding.lifecycle"
            })
          )
        }
        return Effect.gen(function*() {
          yield* requireLifecycleAuthority(
            dispatch.dispatchRequestId,
            binding.checkpoint.occurredAt,
            "sql-work.initialize.legacy-agent-binding.lifecycle"
          )
          if (!metadataTablePresent) return
          const matchingMetadata = legacyMetadata.filter(({ dispatchRequestId }) =>
            dispatchRequestId === dispatch.dispatchRequestId
          )
          const metadata = matchingMetadata[0]
          const encodedWorkLink = metadata?.workLink
          const encodedRoute = metadata?.route
          if (
            matchingMetadata.length !== 1 || encodedWorkLink === null || encodedWorkLink === undefined ||
            encodedRoute === undefined
          ) {
            return yield* new WorkStoreError({
              cause: { dispatch, matchingMetadata },
              operation: "sql-work.migrate.legacy-metadata-authority"
            })
          }
          const workLink = yield* Effect.try({
            try: () => Schema.decodeUnknownSync(LegacyMetadataWorkLink)(JSON.parse(encodedWorkLink)),
            catch: storeError("sql-work.migrate.legacy-metadata-authority")
          })
          yield* requireMetadataAuthority(
            dispatch.dispatchRequestId,
            encodedRoute,
            workLink.lineage,
            "sql-work.migrate.legacy-metadata-authority"
          )
        })
      }, { discard: true })
      if (
        legacyLanes.length > 0 || legacyDecisions.length > 0 ||
        !laneColumns.some(({ name }) => name === "goal_id") ||
        !decisionColumns.some(({ name }) => name === "session_id")
      ) {
        if (!laneColumns.some(({ name }) => name === "goal_id")) {
          yield* sql`ALTER TABLE work_lane_claims ADD COLUMN goal_id TEXT`
          yield* sql`ALTER TABLE work_lane_claims ADD COLUMN operation_id TEXT`
          yield* sql`ALTER TABLE work_lane_claims ADD COLUMN phase TEXT`
          yield* Effect.forEach(
            legacyLanes,
            (lane) =>
              sql`UPDATE work_lane_claims SET goal_id = ${lane.goalId}, operation_id = ${lane.operationId},
                  phase = ${lane.phase}, record = ${JSON.stringify(lane)} WHERE lane_id = ${lane.laneId}`,
            { discard: true }
          )
        }
        if (!decisionColumns.some(({ name }) => name === "session_id")) {
          yield* sql`ALTER TABLE work_decision_handoffs ADD COLUMN session_id TEXT`
        }
        yield* Effect.forEach(legacyDecisions, (handoff) =>
          sql`UPDATE work_decision_handoffs
              SET session_id = ${handoff.sessionId}, record = ${JSON.stringify(handoff)}
              WHERE handoff_id = ${handoff.id}`, { discard: true })
        yield* Effect.forEach(legacyDispatches, (dispatch) => {
          const handoff = legacyDecisions.find(({ id }) => id === dispatch.handoffId)
          if (handoff === undefined) return Effect.void
          const workLink = { handoff, lineage: handoff.dispatchIds }
          return Effect.all([
            sql`UPDATE work_dispatch_handoffs SET record = ${JSON.stringify(handoff)}
                WHERE dispatch_request_id = ${dispatch.dispatchRequestId}`,
            tables.some(({ name }) => name === "orchestrator_dispatch_metadata")
              ? sql`UPDATE orchestrator_dispatch_metadata SET work_link = ${JSON.stringify(workLink)}
                    WHERE dispatch_request_id = ${dispatch.dispatchRequestId}`
              : Effect.void
          ], { discard: true })
        }, { discard: true })
      }
      const storedDecisions = yield* sql`
        SELECT handoff_id AS "handoffId", session_id AS "sessionId", lane_id AS "laneId",
          occurred_at AS "occurredAt", record
        FROM work_decision_handoffs
      `.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(DecisionRow))),
        Effect.mapError(storeError("sql-work.initialize.persisted-handoffs"))
      )
      yield* requireCoordinatorSchema("sql-work.initialize")
      const migrationResults = yield* Effect.forEach(storedDecisions, (row) =>
        Effect.gen(function*() {
          const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(row.record).pipe(
            Effect.mapError(storeError("sql-work.initialize.parse-handoff"))
          )
          const previous = decodePreviousDecisionHandoff(input)
          if (previous._tag === "current") {
            if (
              previous.value.id !== row.handoffId || previous.value.sessionId !== row.sessionId ||
              previous.value.laneId !== row.laneId || previous.value.occurredAt !== row.occurredAt
            ) {
              return yield* new WorkStoreError({
                cause: { handoff: previous.value, row },
                operation: "sql-work.initialize.handoff-identity"
              })
            }
            return false
          }
          if (previous._tag === "invalid") {
            return yield* new WorkStoreError({
              cause: previous.cause,
              operation: "sql-work.initialize.invalid-handoff"
            })
          }
          const laneRows = yield* sql`SELECT revision FROM work_lane_claims WHERE lane_id = ${row.laneId}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(LaneRevisionRow))),
            Effect.mapError(storeError("sql-work.initialize.handoff-lane-revision"))
          )
          const laneRevision = laneRows[0]
          if (laneRevision === undefined) {
            return yield* new WorkStoreError({ cause: row, operation: "sql-work.initialize.handoff-lane" })
          }
          const handoffDispatches = legacyDispatches.filter(({ handoffId }) => handoffId === row.handoffId)
          if (handoffDispatches.length > 1) {
            return yield* new WorkStoreError({
              cause: { handoffDispatches, row },
              operation: "sql-work.initialize.dispatch-cardinality"
            })
          }
          const linkedMetadata = tables.some(({ name }) => name === "orchestrator_dispatch_metadata")
            ? yield* sql`
              SELECT dispatch_request_id AS "dispatchRequestId", route, work_link AS "workLink"
              FROM orchestrator_dispatch_metadata
              WHERE work_link IS NOT NULL
                AND CASE WHEN json_valid(work_link)
                  THEN json_extract(work_link, '$.handoff.id') END = ${row.handoffId}
            `.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(MetadataWorkLinkRow))),
              Effect.mapError(storeError("sql-work.initialize.metadata-authority"))
            )
            : []
          if (
            linkedMetadata.length !== handoffDispatches.length ||
            linkedMetadata.some((metadata) =>
              !handoffDispatches.some(({ dispatchRequestId }) => dispatchRequestId === metadata.dispatchRequestId)
            )
          ) {
            return yield* new WorkStoreError({
              cause: { handoffDispatches, linkedMetadata, row },
              operation: "sql-work.initialize.metadata-authority"
            })
          }
          const bindingRows = tables.some(({ name }) => name === "work_agent_bindings")
            ? yield* sql`
              SELECT binding.dispatch_request_id AS "dispatchRequestId", binding.lane_id AS "laneId",
                binding.expected_revision AS "expectedRevision", binding.revision,
                binding.agent_id AS "agentId", binding.host, binding.record
              FROM work_agent_bindings binding
              JOIN work_dispatch_handoffs dispatch
                ON dispatch.dispatch_request_id = binding.dispatch_request_id
              WHERE dispatch.handoff_id = ${row.handoffId}
            `.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(AgentBindingRow))),
              Effect.mapError(storeError("sql-work.initialize.handoff-binding-row"))
            )
            : []
          const bindingRow = bindingRows[0]
          const handoffDispatch = bindingRow === undefined
            ? undefined
            : handoffDispatches.find(
              ({ dispatchRequestId }) => dispatchRequestId === bindingRow.dispatchRequestId
            )
          if (bindingRows.length !== 1 || bindingRow === undefined || handoffDispatch === undefined) {
            return yield* new WorkStoreError({
              cause: { bindingRows, row },
              operation: "sql-work.initialize.handoff-revision"
            })
          }
          const bindingDecision = decodeAgentBindingRow(
            bindingRow,
            { dispatchRequestId: handoffDispatch.dispatchRequestId, laneId: previous.value.laneId },
            "sql-work.initialize.agent-binding"
          )
          if (bindingDecision._tag === "invalid") return yield* bindingDecision.error
          if (bindingDecision.binding.lane.goalId !== previous.value.goalId) {
            return yield* new WorkStoreError({
              cause: { binding: bindingDecision.binding, previous: previous.value },
              operation: "sql-work.initialize.agent-binding.goal"
            })
          }
          const bindingCompanions = yield* Effect.all({
            checkpointRows: sql`
              SELECT event_id AS "eventId", goal_id AS "goalId", occurred_at AS "occurredAt", record
              FROM work_goal_events WHERE event_id = ${bindingDecision.binding.checkpoint.eventId}
            `.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(AgentBindingGoalEventRow))),
              Effect.mapError(storeError("sql-work.initialize.agent-binding.checkpoint-companion"))
            ),
            laneRows: sql`
              SELECT operation_id AS "operationId", lane_id AS "laneId", goal_id AS "goalId",
                phase, revision, record
              FROM work_lane_operations WHERE operation_id = ${bindingDecision.binding.lane.operationId}
            `.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(AgentBindingLaneOperationRow))),
              Effect.mapError(storeError("sql-work.initialize.agent-binding.lane-companion"))
            )
          })
          const bindingReadbackError = agentBindingReadbackError(
            bindingDecision.binding,
            bindingCompanions.laneRows[0],
            bindingCompanions.checkpointRows[0],
            "sql-work.initialize.agent-binding"
          )
          if (bindingReadbackError !== undefined) return yield* bindingReadbackError
          yield* requireLifecycleAuthority(
            bindingDecision.binding.request.dispatchRequestId,
            bindingDecision.binding.checkpoint.occurredAt,
            "sql-work.initialize.agent-binding.lifecycle"
          )
          const verifiedDispatches = yield* Effect.forEach(handoffDispatches, (dispatch) =>
            Effect.gen(function*() {
              const decoded = yield* Effect.try({
                try: () => ({
                  handoff: Schema.decodeUnknownSync(PreviousWorkDecisionHandoff)(JSON.parse(dispatch.record)),
                  lineage: Schema.decodeUnknownSync(WorkDispatchHandoff.fields.lineage)(JSON.parse(dispatch.lineage))
                }),
                catch: storeError("sql-work.initialize.decode-dispatch-authority")
              })
              if (
                dispatch.laneId !== previous.value.laneId || dispatch.occurredAt !== previous.value.occurredAt ||
                !previousDecisionHandoffEquivalent(decoded.handoff, previous.value) ||
                !workDispatchLineageContainedBy(decoded.lineage, previous.value.dispatchIds)
              ) {
                return yield* new WorkStoreError({
                  cause: { decoded, dispatch, previous: previous.value },
                  operation: "sql-work.initialize.dispatch-authority"
                })
              }
              if (tables.some(({ name }) => name === "orchestrator_dispatch_metadata")) {
                const metadata = linkedMetadata.find(({ dispatchRequestId }) =>
                  dispatchRequestId === dispatch.dispatchRequestId
                )
                const encodedWorkLink = metadata?.workLink
                const encodedRoute = metadata?.route
                if (encodedWorkLink === null || encodedWorkLink === undefined || encodedRoute === undefined) {
                  return yield* new WorkStoreError({
                    cause: { dispatch, linkedMetadata },
                    operation: "sql-work.initialize.metadata-authority"
                  })
                }
                const workLink = yield* Effect.try({
                  try: () => Schema.decodeUnknownSync(PreviousMetadataWorkLink)(JSON.parse(encodedWorkLink)),
                  catch: storeError("sql-work.initialize.decode-metadata-authority")
                })
                yield* requireMetadataAuthority(
                  dispatch.dispatchRequestId,
                  encodedRoute,
                  workLink.lineage,
                  "sql-work.initialize.metadata-authority"
                )
                if (
                  !previousDecisionHandoffEquivalent(workLink.handoff, previous.value) ||
                  !workDispatchLineageEquivalent(workLink.lineage, decoded.lineage)
                ) {
                  return yield* new WorkStoreError({
                    cause: { previous: previous.value, workLink },
                    operation: "sql-work.initialize.metadata-authority"
                  })
                }
              }
              return { dispatch, lineage: decoded.lineage }
            }))
          const migrated = yield* Effect.try({
            try: () =>
              upgradePreviousDecisionHandoff(
                previous.value,
                bindingDecision.binding.request.expectedRevision
              ),
            catch: storeError("sql-work.initialize.upgrade-handoff")
          })
          if (
            migrated.id !== row.handoffId || migrated.sessionId !== row.sessionId ||
            migrated.laneId !== row.laneId || migrated.occurredAt !== row.occurredAt
          ) {
            return yield* new WorkStoreError({
              cause: { migrated, row },
              operation: "sql-work.initialize.handoff-identity"
            })
          }
          const encoded = JSON.stringify(migrated)
          yield* sql`UPDATE work_decision_handoffs SET record = ${encoded} WHERE handoff_id = ${row.handoffId}`
          yield* sql`UPDATE work_dispatch_handoffs SET record = ${encoded} WHERE handoff_id = ${row.handoffId}`
          if (tables.some(({ name }) => name === "orchestrator_dispatch_metadata")) {
            yield* Effect.forEach(verifiedDispatches, ({ dispatch, lineage }) =>
              sql`UPDATE orchestrator_dispatch_metadata
                SET work_link = ${JSON.stringify({ handoff: migrated, lineage })}
                WHERE dispatch_request_id = ${dispatch.dispatchRequestId}`, { discard: true })
          }
          return true
        }))
      if (legacyDecisions.length > 0 || migrationResults.includes(true)) {
        const migratedLedger = yield* sql`
          SELECT COALESCE(SUM(
            length(CAST(handoff_id AS BLOB)) + length(CAST(record AS BLOB))
          ), 0) AS "decisionBytes"
          FROM work_decision_handoffs
        `.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(
            Schema.Struct({ decisionBytes: Schema.Number })
          ))),
          Effect.mapError(storeError("sql-work.initialize.handoff-capacity"))
        )
        const migratedDecisionBytes = migratedLedger[0]
        if (migratedDecisionBytes === undefined) {
          return yield* new WorkStoreError({
            cause: migratedLedger,
            operation: "sql-work.initialize.missing-handoff-capacity"
          })
        }
        if (migratedDecisionBytes.decisionBytes > workDecisionMaxBytes) {
          return yield* new WorkStoreError({
            cause: migratedLedger,
            operation: "sql-work.initialize.handoff-capacity"
          })
        }
      }
      yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS work_lane_claims_one_active_goal
      ON work_lane_claims (goal_id) WHERE phase <> 'shipped'`
      yield* sql`
      CREATE INDEX IF NOT EXISTS work_lane_operations_lane_revision
        ON work_lane_operations (lane_id, revision)
    `.pipe(Effect.mapError(storeError("sql-work.initialize.lane-operation-index")))
      yield* sql`
      CREATE TRIGGER IF NOT EXISTS work_lane_operations_after_insert
      AFTER INSERT ON work_lane_operations
      BEGIN
        UPDATE work_lane_operation_totals
        SET operation_count = operation_count + 1,
            operation_bytes = operation_bytes +
              length(CAST(NEW.operation_id AS BLOB)) + length(CAST(NEW.record AS BLOB))
        WHERE singleton = 1;
      END
    `.pipe(Effect.mapError(storeError("sql-work.initialize.lane-operation-trigger")))
      yield* sql`
      INSERT OR IGNORE INTO work_lane_operation_totals
        (singleton, operation_count, operation_bytes)
      SELECT 1, COUNT(*), COALESCE(SUM(
        length(CAST(operation_id AS BLOB)) + length(CAST(record AS BLOB))
      ), 0)
      FROM work_lane_operations
    `.pipe(Effect.mapError(storeError("sql-work.initialize.lane-operation-totals-row")))
      yield* sql`
      INSERT OR IGNORE INTO work_lane_operations
        (operation_id, lane_id, goal_id, phase, revision, record)
      SELECT operation_id, lane_id, goal_id, phase, revision, record
      FROM work_lane_claims
    `.pipe(Effect.mapError(storeError("sql-work.initialize.lane-operation-backfill")))
      yield* sql`
      CREATE TRIGGER IF NOT EXISTS work_decision_handoffs_after_insert
      AFTER INSERT ON work_decision_handoffs
      BEGIN
        UPDATE work_decision_totals
        SET decision_count = decision_count + 1,
            decision_bytes = decision_bytes +
              length(CAST(NEW.handoff_id AS BLOB)) + length(CAST(NEW.record AS BLOB))
        WHERE singleton = 1;
      END
    `.pipe(Effect.mapError(storeError("sql-work.initialize.trigger")))
      yield* sql`
      CREATE INDEX IF NOT EXISTS work_dispatch_handoffs_lane
        ON work_dispatch_handoffs (lane_id, occurred_at, dispatch_request_id)
    `.pipe(Effect.mapError(storeError("sql-work.initialize.dispatch-index")))
      yield* sql`
      CREATE INDEX IF NOT EXISTS work_agent_bindings_lane_revision
        ON work_agent_bindings (lane_id, revision)
    `.pipe(Effect.mapError(storeError("sql-work.initialize.agent-binding-index")))
      yield* sql`
      CREATE UNIQUE INDEX IF NOT EXISTS work_decision_handoffs_session
        ON work_decision_handoffs (session_id)
    `.pipe(Effect.mapError(storeError("sql-work.initialize.session-index")))
      yield* sql`
      INSERT OR REPLACE INTO work_decision_totals
        (singleton, decision_count, decision_bytes)
      SELECT 1, COUNT(*), COALESCE(SUM(
        length(CAST(handoff_id AS BLOB)) + length(CAST(record AS BLOB))
      ), 0)
      FROM work_decision_handoffs
    `.pipe(Effect.mapError(storeError("sql-work.initialize.totals-row")))
    }))
  })

  const readDecision = (handoff: WorkDecisionHandoffType) =>
    sql`
      SELECT handoff_id AS "handoffId", session_id AS "sessionId", lane_id AS "laneId",
        occurred_at AS "occurredAt", record
      FROM work_decision_handoffs WHERE handoff_id = ${handoff.id}
    `.pipe(
      Effect.mapError(storeError("sql-work.read-handoff")),
      Effect.flatMap((rows) =>
        Schema.decodeUnknownEffect(Schema.Array(DecisionRow))(rows).pipe(
          Effect.mapError(storeError("sql-work.decode-handoff-row")),
          Effect.flatMap((decoded) => {
            const row = decoded[0]
            return row === undefined
              ? Effect.succeed(null)
              : decodeHandoff(row).pipe(Effect.map((value) => ({ row, value })))
          })
        )
      )
    )

  const readDecisionBySession = (handoff: WorkDecisionHandoffType) =>
    sql`
      SELECT handoff_id AS "handoffId", session_id AS "sessionId", lane_id AS "laneId",
        occurred_at AS "occurredAt", record
      FROM work_decision_handoffs WHERE session_id = ${handoff.sessionId}
    `.pipe(
      Effect.mapError(storeError("sql-work.read-session-handoff")),
      Effect.flatMap((rows) =>
        Schema.decodeUnknownEffect(Schema.Array(DecisionRow))(rows).pipe(
          Effect.mapError(storeError("sql-work.decode-session-handoff-row")),
          Effect.flatMap((decoded) => {
            const row = decoded[0]
            return row === undefined
              ? Effect.succeed(null)
              : decodeHandoff(row).pipe(Effect.map((value) => ({ row, value })))
          })
        )
      )
    )

  const readBinding = (dispatchRequestId: string) =>
    sql`
      SELECT dispatch_request_id AS "dispatchRequestId", handoff_id AS "handoffId",
        lane_id AS "laneId", occurred_at AS "occurredAt", lineage, record
      FROM work_dispatch_handoffs WHERE dispatch_request_id = ${dispatchRequestId}
    `.pipe(
      Effect.mapError(storeError("sql-work.read-dispatch-handoff")),
      Effect.flatMap((rows) =>
        Schema.decodeUnknownEffect(Schema.Array(DispatchHandoffRow))(rows).pipe(
          Effect.mapError(storeError("sql-work.decode-dispatch-handoff-row")),
          Effect.flatMap((decoded) => {
            const row = decoded[0]
            return row === undefined
              ? Effect.succeed(null)
              : decodeDispatchHandoff(row).pipe(Effect.map((value) => ({ row, value })))
          })
        )
      )
    )

  const readAgentBinding = (dispatchRequestId: string) =>
    sql`
      SELECT dispatch_request_id AS "dispatchRequestId", lane_id AS "laneId",
        expected_revision AS "expectedRevision", revision, agent_id AS "agentId", host, record
      FROM work_agent_bindings WHERE dispatch_request_id = ${dispatchRequestId}
    `.pipe(
      Effect.mapError(storeError("sql-work.read-agent-binding")),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(AgentBindingRow))),
      Effect.mapError(storeError("sql-work.decode-agent-binding-row")),
      Effect.flatMap((rows) => {
        const row = rows[0]
        if (row === undefined) return Effect.succeed(null)
        return Effect.try({
          try: () => Schema.decodeUnknownSync(WorkAgentBinding)(JSON.parse(row.record)),
          catch: storeError("sql-work.decode-agent-binding-record")
        }).pipe(
          Effect.flatMap((binding) => {
            if (
              row.dispatchRequestId !== binding.request.dispatchRequestId ||
              row.laneId !== binding.request.laneId ||
              row.expectedRevision !== binding.request.expectedRevision ||
              row.revision !== binding.lane.revision ||
              row.agentId !== binding.request.worker.agentId ||
              row.host.toLowerCase() !== binding.request.worker.host.toLowerCase()
            ) {
              return Effect.fail(
                new WorkStoreError({
                  cause: { binding, row },
                  operation: "sql-work.agent-binding.identity-mismatch"
                })
              )
            }
            return Effect.all({
              checkpointRows: sql`
                SELECT event_id AS "eventId", goal_id AS "goalId", occurred_at AS "occurredAt", record
                FROM work_goal_events WHERE event_id = ${binding.checkpoint.eventId}
              `.pipe(
                Effect.mapError(storeError("sql-work.agent-binding.read-checkpoint-companion")),
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(AgentBindingGoalEventRow))),
                Effect.mapError(storeError("sql-work.agent-binding.decode-checkpoint-companion"))
              ),
              laneRows: sql`
                SELECT operation_id AS "operationId", lane_id AS "laneId", goal_id AS "goalId",
                  phase, revision, record
                FROM work_lane_operations WHERE operation_id = ${binding.lane.operationId}
              `.pipe(
                Effect.mapError(storeError("sql-work.agent-binding.read-lane-companion")),
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(AgentBindingLaneOperationRow))),
                Effect.mapError(storeError("sql-work.agent-binding.decode-lane-companion"))
              )
            }).pipe(
              Effect.flatMap(({ checkpointRows, laneRows }) => {
                const error = agentBindingReadbackError(
                  binding,
                  laneRows[0],
                  checkpointRows[0],
                  "sql-work.agent-binding.readback"
                )
                return error === undefined ? Effect.succeed(binding) : Effect.fail(error)
              })
            )
          })
        )
      })
    )

  const conflict = (binding: WorkDispatchHandoffType) =>
    new WorkDispatchHandoffConflictError({
      dispatchRequestId: binding.dispatchRequestId,
      handoffId: binding.handoff.id
    })

  const readValidatedLaneClaims = Effect.fn("SqliteWorkBridge.readValidatedLaneClaims")(function*() {
    const rows = yield* sql`
      SELECT lane_id AS "laneId", goal_id AS "goalId", operation_id AS "operationId",
        phase, revision, record
      FROM work_lane_claims ORDER BY lane_id ASC LIMIT ${workSnapshotMaxGoals + 1}
    `.pipe(
      Effect.mapError(storeError("sql-work.read-lane-authority")),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(LaneRow))),
      Effect.mapError(storeError("sql-work.decode-lane-authority-rows"))
    )
    if (rows.length > workSnapshotMaxGoals) {
      return yield* new WorkStoreError({ cause: rows.length, operation: "sql-work.lane-authority.capacity" })
    }
    const claims = yield* Effect.forEach(rows, (row) =>
      Effect.try({
        try: () => Schema.decodeUnknownSync(WorkLaneClaimed)(JSON.parse(row.record)),
        catch: storeError("sql-work.decode-lane-authority-record")
      }).pipe(
        Effect.flatMap((claim) =>
          claim.goalId !== row.goalId ||
            claim.laneId !== row.laneId ||
            claim.operationId !== row.operationId ||
            claim.phase !== row.phase ||
            claim.revision !== row.revision
            ? Effect.fail(
              new WorkStoreError({
                cause: { claim, row },
                operation: "sql-work.lane-authority.identity-mismatch"
              })
            )
            : Effect.succeed(claim)
        )
      ))
    return claims
  })

  const requireActiveAuthority = Effect.fn("SqliteWorkBridge.requireActiveAuthority")(function*(
    handoff: WorkDecisionHandoffType
  ) {
    const claims = yield* readValidatedLaneClaims()
    const activeGoalClaims = claims.filter((claim) => claim.goalId === handoff.goalId && claim.phase !== "shipped")
    const activeClaim = activeGoalClaims[0]
    if (activeGoalClaims.length !== 1 || activeClaim?.laneId !== handoff.laneId) {
      return yield* new WorkDecisionAuthorityConflictError({ goalId: handoff.goalId, laneId: handoff.laneId })
    }
    if (activeClaim.revision !== handoff.expectedRevision) {
      return yield* new WorkDecisionRevisionConflictError({
        actualRevision: activeClaim.revision,
        expectedRevision: handoff.expectedRevision,
        laneId: handoff.laneId
      })
    }
  })

  const acceptAgentBinding: SqliteWorkBridge["acceptAgentBinding"] = Effect.fn(
    "SqliteWorkBridge.acceptAgentBinding"
  )(function*(request, boundaryTime) {
    const decoded = yield* Schema.decodeUnknownEffect(WorkAgentBindingRequest)(request).pipe(
      Effect.mapError(storeError("sql-work.agent-binding.decode"))
    )
    const decodedBoundaryTime = yield* Schema.decodeUnknownEffect(WorkGoalCheckpoint.fields.occurredAt)(
      boundaryTime
    ).pipe(Effect.mapError(storeError("sql-work.agent-binding.decode-time")))
    const existing = yield* readAgentBinding(decoded.dispatchRequestId)
    if (existing !== null) {
      return Equal.equals(existing.request, decoded)
        ? { _tag: "replayed", binding: existing }
        : yield* new WorkAgentBindingConflictError({ dispatchRequestId: decoded.dispatchRequestId })
    }
    const laneClaims = yield* readValidatedLaneClaims()
    const lane = laneClaims.find(({ laneId }) => laneId === decoded.laneId)
    if (lane === undefined) {
      return yield* new WorkAgentBindingAuthorityError({
        actualRevision: 0,
        expectedRevision: decoded.expectedRevision,
        laneId: decoded.laneId,
        reason: "missing_lane"
      })
    }
    if (lane.revision !== decoded.expectedRevision) {
      return yield* new WorkAgentBindingAuthorityError({
        actualRevision: lane.revision,
        expectedRevision: decoded.expectedRevision,
        laneId: decoded.laneId,
        reason: "stale_revision"
      })
    }
    if (lane.phase === "shipped") {
      return yield* new WorkAgentBindingAuthorityError({
        actualRevision: lane.revision,
        expectedRevision: decoded.expectedRevision,
        laneId: decoded.laneId,
        reason: "shipped_lane"
      })
    }
    const activeGoalClaims = laneClaims.filter((claim) => claim.goalId === lane.goalId && claim.phase !== "shipped")
    if (activeGoalClaims.length !== 1 || activeGoalClaims[0]?.laneId !== lane.laneId) {
      return yield* new WorkStoreError({
        cause: { activeGoalClaims, lane },
        operation: "sql-work.agent-binding.goal-authority-conflict"
      })
    }
    const currentRows = yield* sql`
      SELECT event_id AS "eventId", goal_id AS "goalId", occurred_at AS "occurredAt", record
      FROM work_goal_events
      WHERE goal_id = ${lane.goalId}
      ORDER BY occurred_at DESC, event_id DESC LIMIT 1
    `.pipe(
      Effect.mapError(storeError("sql-work.agent-binding.read-goal")),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(AgentBindingGoalEventRow))),
      Effect.mapError(storeError("sql-work.agent-binding.decode-goal-row"))
    )
    const currentRow = currentRows[0]
    if (currentRow === undefined) {
      return yield* new WorkAgentBindingAuthorityError({
        actualRevision: lane.revision,
        expectedRevision: decoded.expectedRevision,
        laneId: decoded.laneId,
        reason: "missing_goal"
      })
    }
    const currentDecision = decodeAgentBindingGoalEvent(currentRow, "sql-work.agent-binding.current-goal")
    if (currentDecision._tag === "invalid") return yield* currentDecision.error
    const current = currentDecision.checkpoint
    if (current.goal.state === "completed") {
      return yield* new WorkAgentBindingAuthorityError({
        actualRevision: lane.revision,
        expectedRevision: decoded.expectedRevision,
        laneId: decoded.laneId,
        reason: "terminal_goal"
      })
    }
    if (current.occurredAt > decodedBoundaryTime) {
      return yield* new WorkProjectionError({
        cause: { boundaryTime: decodedBoundaryTime, checkpoint: current },
        detail: "work agent binding cannot advance beyond the coordinator clock",
        reason: "inconsistent_history"
      })
    }
    if (current.occurredAt >= 8_640_000_000_000_000) {
      return yield* new WorkProjectionError({
        cause: decoded,
        detail: "work agent binding timestamp cannot advance",
        reason: "capacity_exceeded"
      })
    }
    const occurredAt = Math.max(decodedBoundaryTime, current.occurredAt + 1)
    const binding = makeWorkAgentBinding(
      decoded,
      lane,
      current,
      occurredAt
    )
    const encodedLane = JSON.stringify(binding.lane)
    const history = yield* sql`
      SELECT event_id AS "eventId", goal_id AS "goalId", occurred_at AS "occurredAt", record
      FROM work_goal_events ORDER BY occurred_at ASC, event_id ASC
      LIMIT ${workHistoryMaxEvents + 1}
    `.pipe(
      Effect.mapError(storeError("sql-work.agent-binding.read-history")),
      Effect.flatMap((rows) =>
        Schema.decodeUnknownEffect(Schema.Array(AgentBindingGoalEventRow))(rows).pipe(
          Effect.mapError(storeError("sql-work.agent-binding.decode-history-rows"))
        )
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => {
          const decision = decodeAgentBindingGoalEvent(row, "sql-work.agent-binding.history")
          return decision._tag === "valid" ? Effect.succeed(decision.checkpoint) : Effect.fail(decision.error)
        })
      )
    )
    const operationTotalsRows = yield* sql`
      SELECT operation_count AS "operationCount", operation_bytes AS "operationBytes"
      FROM work_lane_operation_totals WHERE singleton = 1
    `.pipe(
      Effect.mapError(storeError("sql-work.agent-binding.read-operation-totals")),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(LaneOperationLedgerTotalsRow))),
      Effect.mapError(storeError("sql-work.agent-binding.decode-operation-totals"))
    )
    const operationTotals = operationTotalsRows[0]
    if (operationTotals === undefined) {
      return yield* new WorkStoreError({
        cause: operationTotalsRows,
        operation: "sql-work.agent-binding.missing-operation-totals"
      })
    }
    const admissionError = agentBindingAdmissionError({
      candidate: binding.checkpoint,
      candidateOperationBytes: encodedBytes(binding.lane.operationId) + encodedBytes(encodedLane),
      history,
      operationBytes: operationTotals.operationBytes,
      operationCount: operationTotals.operationCount
    })
    if (admissionError !== undefined) return yield* admissionError
    const updated = yield* sql`
      UPDATE work_lane_claims
      SET operation_id = ${binding.lane.operationId}, revision = ${binding.lane.revision}, record = ${encodedLane}
      WHERE lane_id = ${decoded.laneId} AND revision = ${decoded.expectedRevision}
      RETURNING lane_id
    `.pipe(Effect.mapError(storeError("sql-work.agent-binding.update-lane")))
    if (updated.length !== 1) {
      return yield* new WorkAgentBindingAuthorityError({
        actualRevision: lane.revision,
        expectedRevision: decoded.expectedRevision,
        laneId: decoded.laneId,
        reason: "stale_revision"
      })
    }
    yield* sql`
      INSERT INTO work_lane_operations (operation_id, lane_id, goal_id, phase, revision, record)
      VALUES (${binding.lane.operationId}, ${binding.lane.laneId}, ${binding.lane.goalId},
        ${binding.lane.phase}, ${binding.lane.revision}, ${encodedLane})
    `.pipe(Effect.mapError(storeError("sql-work.agent-binding.insert-lane-operation")))
    yield* sql`
      INSERT INTO work_goal_events (event_id, goal_id, occurred_at, record)
      VALUES (${binding.checkpoint.eventId}, ${binding.checkpoint.goal.id},
        ${binding.checkpoint.occurredAt}, ${JSON.stringify(binding.checkpoint)})
    `.pipe(Effect.mapError(storeError("sql-work.agent-binding.insert-goal-event")))
    yield* sql`
      INSERT INTO work_agent_bindings
        (dispatch_request_id, lane_id, expected_revision, revision, agent_id, host, record)
      VALUES (${decoded.dispatchRequestId}, ${decoded.laneId}, ${decoded.expectedRevision},
        ${binding.lane.revision}, ${decoded.worker.agentId}, ${decoded.worker.host}, ${JSON.stringify(binding)})
    `.pipe(Effect.mapError(storeError("sql-work.agent-binding.insert")))
    return { _tag: "inserted", binding }
  })

  const requireAgentBinding: SqliteWorkBridge["requireAgentBinding"] = Effect.fn(
    "SqliteWorkBridge.requireAgentBinding"
  )(function*(request) {
    const decoded = yield* Schema.decodeUnknownEffect(WorkAgentBindingRequest)(request).pipe(
      Effect.mapError(storeError("sql-work.agent-binding.require.decode"))
    )
    const existing = yield* readAgentBinding(decoded.dispatchRequestId)
    if (existing === null) {
      return yield* new WorkStoreError({ cause: decoded, operation: "sql-work.agent-binding.require.missing" })
    }
    return Equal.equals(existing.request, decoded)
      ? existing
      : yield* new WorkAgentBindingConflictError({ dispatchRequestId: decoded.dispatchRequestId })
  })

  const acceptDispatchHandoff: SqliteWorkBridge["acceptDispatchHandoff"] = Effect.fn(
    "SqliteWorkBridge.acceptDispatchHandoff"
  )(function*(binding) {
    const decoded = yield* Schema.decodeUnknownEffect(WorkDispatchHandoff)(binding).pipe(
      Effect.mapError(storeError("sql-work.accept.decode"))
    )
    const existingBinding = yield* readBinding(decoded.dispatchRequestId)
    if (existingBinding !== null) {
      if (!Equal.equals(existingBinding.value, decoded)) return yield* conflict(decoded)
      const existingDecision = yield* readDecision(decoded.handoff)
      return existingDecision !== null && Equal.equals(existingDecision.value, decoded.handoff)
        ? existingBinding.value
        : yield* new WorkStoreError({ cause: decoded, operation: "sql-work.accept.decision-mismatch" })
    }
    yield* requireActiveAuthority(decoded.handoff)

    const existingSessionHandoff = yield* readDecisionBySession(decoded.handoff)
    if (existingSessionHandoff !== null && !Equal.equals(existingSessionHandoff.value, decoded.handoff)) {
      return yield* new WorkCoordinatorHandoffConflictError({ sessionId: decoded.handoff.sessionId })
    }
    const existingHandoff = yield* readDecision(decoded.handoff)
    if (existingHandoff !== null && !Equal.equals(existingHandoff.value, decoded.handoff)) {
      return yield* new WorkDecisionHandoffConflictError({ handoffId: decoded.handoff.id })
    }
    if (existingHandoff === null) {
      const encodedHandoff = JSON.stringify(decoded.handoff)
      const totals = yield* sql`
        SELECT decision_count AS "decisionCount", decision_bytes AS "decisionBytes"
        FROM work_decision_totals WHERE singleton = 1
      `.pipe(
        Effect.mapError(storeError("sql-work.read-totals")),
        Effect.flatMap((rows) =>
          Schema.decodeUnknownEffect(Schema.Array(DecisionLedgerTotalsRow))(rows).pipe(
            Effect.mapError(storeError("sql-work.decode-totals")),
            Effect.flatMap((decodedRows) => {
              const row = decodedRows[0]
              return row === undefined
                ? Effect.fail(new WorkStoreError({ cause: decodedRows, operation: "sql-work.missing-totals" }))
                : Effect.succeed(row)
            })
          )
        )
      )
      const handoffBytes = encodedBytes(decoded.handoff.id) + encodedBytes(encodedHandoff)
      if (totals.decisionCount >= workDecisionMaxRecords) {
        return yield* new WorkProjectionError({
          cause: decoded,
          detail: `work decision history cannot exceed ${workDecisionMaxRecords} handoffs`,
          reason: "capacity_exceeded"
        })
      }
      if (totals.decisionBytes + handoffBytes > workDecisionMaxBytes) {
        return yield* new WorkProjectionError({
          cause: decoded,
          detail: `work decision history cannot exceed ${workDecisionMaxBytes} encoded bytes`,
          reason: "capacity_exceeded"
        })
      }
      yield* sql`
        INSERT INTO work_decision_handoffs (handoff_id, session_id, lane_id, occurred_at, record)
        VALUES (${decoded.handoff.id}, ${decoded.handoff.sessionId}, ${decoded.handoff.laneId},
          ${decoded.handoff.occurredAt}, ${encodedHandoff})
      `.pipe(Effect.mapError(storeError("sql-work.insert-handoff")))
    }

    const encodedLineage = JSON.stringify(decoded.lineage)
    const encodedRecord = JSON.stringify(decoded.handoff)
    const inserted = yield* sql`
      INSERT INTO work_dispatch_handoffs
        (dispatch_request_id, handoff_id, lane_id, occurred_at, lineage, record)
      VALUES (${decoded.dispatchRequestId}, ${decoded.handoff.id}, ${decoded.handoff.laneId},
        ${decoded.handoff.occurredAt}, ${encodedLineage}, ${encodedRecord})
      ON CONFLICT DO NOTHING
      RETURNING dispatch_request_id AS "dispatchRequestId", handoff_id AS "handoffId",
        lane_id AS "laneId", occurred_at AS "occurredAt", lineage, record
    `.pipe(Effect.mapError(storeError("sql-work.insert-dispatch-handoff")))
    if (inserted.length > 0) return decoded
    const winner = yield* readBinding(decoded.dispatchRequestId)
    return winner !== null && Equal.equals(winner.value, decoded)
      ? winner.value
      : yield* conflict(decoded)
  })

  const requireDispatchHandoff: SqliteWorkBridge["requireDispatchHandoff"] = Effect.fn(
    "SqliteWorkBridge.requireDispatchHandoff"
  )(function*(binding) {
    const decoded = yield* Schema.decodeUnknownEffect(WorkDispatchHandoff)(binding).pipe(
      Effect.mapError(storeError("sql-work.require.decode"))
    )
    const existing = yield* readBinding(decoded.dispatchRequestId)
    if (existing === null) {
      return yield* new WorkStoreError({ cause: decoded, operation: "sql-work.require.missing" })
    }
    if (!Equal.equals(existing.value, decoded)) return yield* conflict(decoded)
    const decision = yield* readDecision(decoded.handoff)
    if (decision === null || !Equal.equals(decision.value, decoded.handoff)) {
      return yield* new WorkStoreError({ cause: decoded, operation: "sql-work.require.decision-mismatch" })
    }
    return existing.value
  })

  return {
    acceptAgentBinding,
    acceptDispatchHandoff,
    initialize,
    requireAgentBinding,
    requireDispatchHandoff
  }
}
