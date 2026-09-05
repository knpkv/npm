import { fleetResponseBodyMaxBytes } from "@knpkv/herdr-fleet"
import { Clock, Crypto, Effect, Encoding, Equal, FileSystem, Option, Path, Schema } from "effect"
import { DatabaseSync, type SQLOutputValue } from "node:sqlite"
import { makeWorkAgentBinding } from "./agent-binding.js"
import {
  WorkAgentBindingAuthorityError,
  WorkAgentBindingConflictError,
  WorkCheckpointConflictError,
  WorkCoordinatorHandoffConflictError,
  WorkDecisionAuthorityConflictError,
  WorkDecisionHandoffConflictError,
  WorkDecisionRevisionConflictError,
  WorkLaneClaimConflictError,
  WorkLaneGoalConflictError,
  WorkLaneOperationConflictError,
  WorkProjectionError,
  WorkStoreError,
  WorkTransactionConflictError
} from "./errors.js"
import { validateGoalFamilyHistory } from "./goal-family.js"
import {
  agentBindingAdmissionError,
  workAgentBindingLaneOperationMaxBytes,
  workAgentBindingLaneOperationMaxRecords,
  workAgentBindingMaximumSnapshotBytes,
  workAgentBindingSnapshotEnvelopeMaxBytes,
  workMaximumSnapshotBytesForHistory
} from "./internal/agent-binding-admission.js"
import {
  AgentBindingGoalEventRow,
  AgentBindingLaneOperationRow,
  agentBindingReadbackError,
  AgentBindingRow,
  decodeAgentBindingGoalEvent,
  decodeAgentBindingRow
} from "./internal/agent-binding-readback.js"
import {
  CoordinatorCommandRow,
  CoordinatorLifecycleDispatchRow,
  CoordinatorLifecycleEventRow,
  coordinatorLifecycleRunningAt,
  CoordinatorRouteDiscriminatorRow,
  type CoordinatorRouteStorageAuthority,
  requireCoordinatorFailedLunaAuthority,
  requireCoordinatorLifecycleAuthority,
  requireCoordinatorRouteAuthority
} from "./internal/coordinator-authority.js"
import {
  currentDecisionHandoffEquivalent,
  CurrentMetadataWorkLink,
  decodePreviousDecisionHandoff,
  previousDecisionHandoffEquivalent,
  PreviousWorkDecisionHandoff,
  upgradePreviousDecisionHandoff,
  workDispatchLineageContainedBy,
  workDispatchLineageEquivalent
} from "./internal/decision-handoff-migration.js"
import {
  WorkAgentBinding,
  WorkAgentBindingRequest,
  WorkCoordinatorSessionId,
  WorkDecisionHandoff,
  WorkDispatchHandoff,
  WorkGoalCheckpoint,
  WorkGoalId,
  workHistoryMaxEvents,
  WorkLaneClaim,
  WorkLaneClaimed,
  workSnapshotMaxGoals
} from "./model.js"
import type {
  WorkAgentBinding as WorkAgentBindingType,
  WorkAgentBindingRequest as WorkAgentBindingRequestType,
  WorkDecisionHandoff as WorkDecisionHandoffType,
  WorkGoalCheckpoint as WorkGoalCheckpointType
} from "./model.js"

const StoredEventRow = Schema.Struct({ record: Schema.String })
const StoredEventRows = Schema.Array(StoredEventRow)
const StoredEventWithTransactionRow = Schema.Struct({
  eventId: Schema.String,
  goalId: Schema.String,
  occurredAt: Schema.Number,
  record: Schema.String,
  transactionId: Schema.NullOr(Schema.String)
})
const StoredEventWithTransactionRows = Schema.Array(StoredEventWithTransactionRow)
const TransactionRow = Schema.Struct({ record: Schema.String })
const TransactionEventIdentity = Schema.Struct({
  eventId: Schema.String,
  goalId: Schema.String,
  occurredAt: Schema.Number
})
const LegacyCompactTransactionRecord = Schema.Struct({
  events: Schema.Array(TransactionEventIdentity),
  version: Schema.Literal("herdr.work.transaction.v1")
})
const CompactTransactionRecord = Schema.Struct({
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  version: Schema.Literal("herdr.work.transaction.v3")
})
const PreviousCompactTransactionRecord = Schema.Struct({
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  version: Schema.Literal("herdr.work.transaction.v2")
})
const LaneRow = Schema.Struct({
  goalId: Schema.String,
  laneId: Schema.String,
  operationId: Schema.String,
  phase: Schema.String,
  record: Schema.String,
  revision: Schema.Number
})
const DecisionRow = Schema.Struct({
  handoffId: Schema.String,
  sessionId: Schema.String,
  laneId: Schema.String,
  occurredAt: Schema.Number,
  record: Schema.String
})
const DecisionIdentityRow = Schema.Struct({ handoffId: Schema.String })
const AgentBindingRows = Schema.Array(AgentBindingRow)
const CountRow = Schema.Struct({ count: Schema.Number })
const DecisionLedgerTotalsRow = Schema.Struct({
  decisionBytes: Schema.Number,
  decisionCount: Schema.Number
})
const LedgerBytesRow = Schema.Struct({ bytes: Schema.Number })
const LaneOperationLedgerTotalsRow = Schema.Struct({
  operationBytes: Schema.Number,
  operationCount: Schema.Number
})
const TransactionLedgerTotalsRow = Schema.Struct({
  transactionBytes: Schema.Number,
  transactionCount: Schema.Number
})
const LegacyLaneStoredRow = Schema.Struct({ laneId: Schema.String, record: Schema.String, revision: Schema.Number })
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
const LegacyDecisionStoredRow = Schema.Struct({ handoffId: Schema.String, record: Schema.String })
const LegacyDispatchStoredRow = Schema.Struct({
  dispatchRequestId: Schema.String,
  handoffId: Schema.String,
  laneId: Schema.String,
  occurredAt: Schema.Number,
  lineage: Schema.String,
  record: Schema.String
})
const LaneRevisionRow = Schema.Struct({ revision: Schema.Number })
const MetadataWorkLinkRow = Schema.Struct({
  dispatchRequestId: Schema.String,
  route: Schema.String,
  workLink: Schema.NullOr(Schema.String)
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
const PreviousMetadataWorkLink = Schema.Struct({
  handoff: PreviousWorkDecisionHandoff,
  lineage: WorkDispatchHandoff.fields.lineage
})
const LegacyMetadataWorkLink = Schema.Struct({
  handoff: LegacyDecisionRecord,
  lineage: WorkDispatchHandoff.fields.lineage
})
const legacyDecisionEquivalent = Schema.toEquivalence(LegacyDecisionRecord)
const TransactionId = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(256),
  Schema.isPattern(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/)
)
const storeError = (operation: string) => (cause: unknown) => new WorkStoreError({ cause, operation })

const migrateLegacyAuthorityTables = (database: DatabaseSync): void => {
  let transaction = false
  try {
    database.exec("BEGIN IMMEDIATE")
    transaction = true
    const columns = (table: string) =>
      Schema.decodeUnknownSync(
        Schema.Array(Schema.Struct({ name: Schema.String }))
      )(database.prepare(`PRAGMA table_info(${table})`).all()).map(({ name }) => name)
    const laneColumns = columns("work_lane_claims")
    const decisionColumns = columns("work_decision_handoffs")
    const tables = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    ).map(({ name }) => name)
    const coordinatorDispatchColumns = tables.includes("orchestrator_dispatches")
      ? columns("orchestrator_dispatches")
      : []
    const requireBindingCompanions = (
      binding: WorkAgentBindingType,
      operation: string
    ): void => {
      const laneInput = tables.includes("work_lane_operations")
        ? database.prepare(
          `SELECT operation_id AS operationId, lane_id AS laneId, goal_id AS goalId,
             phase, revision, record
           FROM work_lane_operations WHERE operation_id = ?`
        ).get(binding.lane.operationId)
        : undefined
      const checkpointInput = tables.includes("work_goal_events")
        ? database.prepare(
          `SELECT event_id AS eventId, goal_id AS goalId, occurred_at AS occurredAt, record
           FROM work_goal_events WHERE event_id = ?`
        ).get(binding.checkpoint.eventId)
        : undefined
      const error = agentBindingReadbackError(
        binding,
        laneInput === undefined ? undefined : Schema.decodeUnknownSync(AgentBindingLaneOperationRow)(laneInput),
        checkpointInput === undefined
          ? undefined
          : Schema.decodeUnknownSync(AgentBindingGoalEventRow)(checkpointInput),
        operation
      )
      if (error !== undefined) throw error
    }
    const coordinatorTablesPresent = {
      dispatch: tables.includes("orchestrator_dispatches"),
      event: tables.includes("orchestrator_events"),
      metadata: tables.includes("orchestrator_dispatch_metadata")
    }
    const requireCoordinatorSchema = (operation: string): boolean => {
      const present = Object.values(coordinatorTablesPresent).filter(Boolean).length
      if (present !== 0 && present !== 3) {
        throw new WorkStoreError({ cause: coordinatorTablesPresent, operation: `${operation}.schema` })
      }
      return present === 3
    }
    requireCoordinatorSchema("open.migrate")
    const readCoordinatorLifecycle = (dispatchRequestId: string) => ({
      dispatchRows: Schema.decodeUnknownSync(Schema.Array(CoordinatorLifecycleDispatchRow))(
        database.prepare(
          `SELECT dispatch_request_id AS dispatchRequestId,
           activity_idempotency_key AS activityIdempotencyKey, command,
           accepted_at AS acceptedAt, status
         FROM orchestrator_dispatches WHERE dispatch_request_id = ? LIMIT 2`
        ).all(dispatchRequestId)
      ),
      eventRows: Schema.decodeUnknownSync(Schema.Array(CoordinatorLifecycleEventRow))(
        database.prepare(
          `SELECT dispatch_request_id AS dispatchRequestId, sequence, type,
           activity_idempotency_key AS activityIdempotencyKey,
           occurred_at AS occurredAt, detail, result
         FROM orchestrator_events WHERE dispatch_request_id = ?
         ORDER BY sequence ASC LIMIT 5`
        ).all(dispatchRequestId)
      )
    })
    const routeStorageAuthority = (
      dispatchRequestId: string,
      operation: string
    ): CoordinatorRouteStorageAuthority => {
      if (!coordinatorDispatchColumns.includes("is_routed")) {
        return { _tag: "legacy_without_routed_discriminator" }
      }
      const rows = Schema.decodeUnknownSync(Schema.Array(CoordinatorRouteDiscriminatorRow))(
        database.prepare(
          `SELECT is_routed AS isRouted FROM orchestrator_dispatches
           WHERE dispatch_request_id = ? LIMIT 2`
        ).all(dispatchRequestId)
      )
      const row = rows[0]
      if (rows.length !== 1 || row === undefined) {
        throw new WorkStoreError({ cause: { dispatchRequestId, rows }, operation })
      }
      return { _tag: "routed_discriminator", isRouted: row.isRouted }
    }
    const requireLinkedParentAuthority = (
      linkedRequestId: string | null,
      operation: string
    ): void => {
      if (linkedRequestId === null) return
      const metadataRows = Schema.decodeUnknownSync(Schema.Array(MetadataWorkLinkRow))(
        database.prepare(
          `SELECT dispatch_request_id AS dispatchRequestId, route, work_link AS workLink
           FROM orchestrator_dispatch_metadata WHERE dispatch_request_id = ? LIMIT 2`
        ).all(linkedRequestId)
      )
      const metadata = metadataRows[0]
      if (metadataRows.length !== 1 || metadata === undefined || metadata.workLink !== null) {
        throw new WorkStoreError({ cause: { linkedRequestId, metadataRows }, operation })
      }
      const lifecycle = readCoordinatorLifecycle(linkedRequestId)
      requireCoordinatorFailedLunaAuthority(
        lifecycle.dispatchRows,
        lifecycle.eventRows,
        metadata.route,
        routeStorageAuthority(linkedRequestId, operation),
        operation
      )
    }
    const requireMetadataAuthority = (
      dispatchRequestId: string,
      routeText: string,
      lineage: ReadonlyArray<string>,
      operation: string
    ): void => {
      const commandRows = Schema.decodeUnknownSync(Schema.Array(CoordinatorCommandRow))(
        database.prepare(
          `SELECT activity_idempotency_key AS activityIdempotencyKey, command FROM orchestrator_dispatches
           WHERE dispatch_request_id = ? LIMIT 2`
        ).all(dispatchRequestId)
      )
      const commandRow = commandRows[0]
      if (commandRows.length !== 1 || commandRow === undefined) {
        throw new WorkStoreError({ cause: { commandRows, dispatchRequestId }, operation })
      }
      const route = requireCoordinatorRouteAuthority(
        commandRow.command,
        commandRow.activityIdempotencyKey,
        routeText,
        lineage,
        routeStorageAuthority(dispatchRequestId, operation),
        operation
      )
      requireLinkedParentAuthority(route.linkedRequestId, `${operation}.parent`)
    }
    const requireLifecycleAuthority = (
      dispatchRequestId: string,
      expectedRunningAt: number,
      operation: string
    ): void => {
      if (!requireCoordinatorSchema(operation)) return
      const lifecycle = readCoordinatorLifecycle(dispatchRequestId)
      requireCoordinatorLifecycleAuthority(
        lifecycle.dispatchRows,
        lifecycle.eventRows,
        expectedRunningAt,
        operation
      )
    }
    const requireCurrentAgentBindingAuthority = (
      dispatchRequestId: string,
      handoff: WorkDecisionHandoffType,
      operation: string
    ): void => {
      const lifecycle = readCoordinatorLifecycle(dispatchRequestId)
      const runningAt = coordinatorLifecycleRunningAt(
        lifecycle.dispatchRows,
        lifecycle.eventRows,
        `${operation}.lifecycle`
      )
      const bindingRows = tables.includes("work_agent_bindings")
        ? Schema.decodeUnknownSync(Schema.Array(AgentBindingRow))(
          database.prepare(
            `SELECT dispatch_request_id AS dispatchRequestId, lane_id AS laneId,
               expected_revision AS expectedRevision, revision, agent_id AS agentId, host, record
             FROM work_agent_bindings WHERE dispatch_request_id = ? LIMIT 2`
          ).all(dispatchRequestId)
        )
        : []
      if (runningAt === null && bindingRows.length === 0) return
      const bindingRow = bindingRows[0]
      if (runningAt === null || bindingRows.length !== 1 || bindingRow === undefined) {
        throw new WorkStoreError({ cause: { bindingRows, lifecycle }, operation })
      }
      const decoded = decodeAgentBindingRow(
        bindingRow,
        { dispatchRequestId, laneId: handoff.laneId },
        operation
      )
      if (decoded._tag === "invalid") throw decoded.error
      if (
        decoded.binding.request.expectedRevision !== handoff.expectedRevision ||
        decoded.binding.lane.goalId !== handoff.goalId ||
        decoded.binding.checkpoint.occurredAt !== runningAt
      ) {
        throw new WorkStoreError({ cause: { binding: decoded.binding, handoff, runningAt }, operation })
      }
      requireBindingCompanions(decoded.binding, operation)
    }
    const dispatches = tables.includes("work_dispatch_handoffs")
      ? Schema.decodeUnknownSync(Schema.Array(LegacyDispatchStoredRow))(
        database.prepare(
          `SELECT dispatch_request_id AS dispatchRequestId, handoff_id AS handoffId,
             lane_id AS laneId, occurred_at AS occurredAt, lineage, record
           FROM work_dispatch_handoffs`
        ).all()
      )
      : []
    const decisionIdentities = decisionColumns.length > 0
      ? Schema.decodeUnknownSync(Schema.Array(DecisionIdentityRow))(
        database.prepare("SELECT handoff_id AS handoffId FROM work_decision_handoffs").all()
      )
      : []
    const orphanDispatch = dispatches.find(({ handoffId }) =>
      !decisionIdentities.some((decision) => decision.handoffId === handoffId)
    )
    if (orphanDispatch !== undefined) {
      throw new WorkStoreError({
        cause: { decisionIdentities, dispatch: orphanDispatch },
        operation: "open.migrate.dispatch-decision"
      })
    }
    const lanes = laneColumns.length > 0 && !laneColumns.includes("goal_id")
      ? Schema.decodeUnknownSync(Schema.Array(LegacyLaneStoredRow))(
        database.prepare("SELECT lane_id AS laneId, revision, record FROM work_lane_claims").all()
      ).map((row) => {
        const legacy = Schema.decodeUnknownSync(LegacyLaneRecord)(JSON.parse(row.record))
        if (legacy.laneId !== row.laneId || legacy.revision !== row.revision) {
          throw new WorkStoreError({ cause: { legacy, row }, operation: "open.migrate.lane-identity" })
        }
        return Schema.decodeUnknownSync(WorkLaneClaimed)({
          ...legacy,
          goalId: legacy.laneId,
          operationId: legacy.laneId
        })
      })
      : []
    const decisions = decisionColumns.length > 0 && !decisionColumns.includes("session_id")
      ? Schema.decodeUnknownSync(Schema.Array(LegacyDecisionStoredRow))(
        database.prepare("SELECT handoff_id AS handoffId, record FROM work_decision_handoffs").all()
      ).map((row) => {
        const legacy = Schema.decodeUnknownSync(LegacyDecisionRecord)(JSON.parse(row.record))
        if (legacy.id !== row.handoffId) {
          throw new WorkStoreError({ cause: { legacy, row }, operation: "open.migrate.handoff-identity" })
        }
        const matchingDispatches = dispatches.filter(({ handoffId }) => handoffId === legacy.id)
        const dispatch = matchingDispatches[0]
        const lane = lanes.find(({ laneId }) => laneId === legacy.laneId)
        if (lane === undefined) {
          throw new WorkStoreError({ cause: legacy, operation: "open.migrate.handoff-lane" })
        }
        const dispatchIds = dispatch === undefined
          ? []
          : Schema.decodeUnknownSync(WorkDispatchHandoff.fields.lineage)(JSON.parse(dispatch.lineage))
        if (matchingDispatches.length !== 1 || dispatch === undefined) {
          throw new WorkStoreError({
            cause: { legacy, matchingDispatches },
            operation: "open.migrate.legacy-dispatch-cardinality"
          })
        }
        const dispatchHandoff = Schema.decodeUnknownSync(LegacyDecisionRecord)(JSON.parse(dispatch.record))
        if (
          dispatch.laneId !== legacy.laneId || dispatch.occurredAt !== legacy.occurredAt ||
          !legacyDecisionEquivalent(dispatchHandoff, legacy)
        ) {
          throw new WorkStoreError({
            cause: { dispatch, dispatchHandoff, legacy },
            operation: "open.migrate.legacy-dispatch-authority"
          })
        }
        if (tables.includes("orchestrator_dispatch_metadata")) {
          const metadataInput = database.prepare(
            `SELECT dispatch_request_id AS dispatchRequestId, route, work_link AS workLink
             FROM orchestrator_dispatch_metadata WHERE dispatch_request_id = ?`
          ).get(dispatch.dispatchRequestId)
          if (metadataInput === undefined) {
            throw new WorkStoreError({
              cause: dispatch,
              operation: "open.migrate.legacy-metadata-authority"
            })
          }
          const metadata = Schema.decodeUnknownSync(MetadataWorkLinkRow)(metadataInput)
          if (metadata.workLink === null) {
            throw new WorkStoreError({
              cause: { dispatch, metadata },
              operation: "open.migrate.legacy-metadata-authority"
            })
          }
          const workLink = Schema.decodeUnknownSync(LegacyMetadataWorkLink)(JSON.parse(metadata.workLink))
          requireMetadataAuthority(
            dispatch.dispatchRequestId,
            metadata.route,
            workLink.lineage,
            "open.migrate.legacy-metadata-authority"
          )
          if (
            !legacyDecisionEquivalent(workLink.handoff, legacy) ||
            !workDispatchLineageEquivalent(workLink.lineage, dispatchIds)
          ) {
            throw new WorkStoreError({
              cause: { legacy, workLink },
              operation: "open.migrate.legacy-metadata-authority"
            })
          }
        }
        const bindingRows = tables.includes("work_agent_bindings")
          ? Schema.decodeUnknownSync(Schema.Array(AgentBindingRow))(
            database.prepare(
              `SELECT dispatch_request_id AS dispatchRequestId, lane_id AS laneId,
                 expected_revision AS expectedRevision, revision, agent_id AS agentId, host, record
               FROM work_agent_bindings
               WHERE dispatch_request_id = ?`
            ).all(dispatch.dispatchRequestId)
          )
          : []
        const bindingRow = bindingRows[0]
        if (bindingRows.length !== 1 || bindingRow === undefined) {
          throw new WorkStoreError({
            cause: { bindingRows, dispatch, legacy },
            operation: "open.migrate.legacy-handoff-revision"
          })
        }
        const bindingDecision = decodeAgentBindingRow(
          bindingRow,
          { dispatchRequestId: dispatch.dispatchRequestId, laneId: legacy.laneId },
          "open.migrate.legacy-agent-binding"
        )
        if (bindingDecision._tag === "invalid") throw bindingDecision.error
        if (bindingDecision.binding.lane.goalId !== legacy.goalId) {
          throw new WorkStoreError({
            cause: { binding: bindingDecision.binding, legacy },
            operation: "open.migrate.legacy-agent-binding.goal"
          })
        }
        requireBindingCompanions(bindingDecision.binding, "open.migrate.legacy-agent-binding")
        requireLifecycleAuthority(
          bindingDecision.binding.request.dispatchRequestId,
          bindingDecision.binding.checkpoint.occurredAt,
          "open.migrate.legacy-agent-binding.lifecycle"
        )
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
      })
      : []
    if (laneColumns.length > 0 && !laneColumns.includes("goal_id")) {
      database.exec("ALTER TABLE work_lane_claims ADD COLUMN goal_id TEXT")
      database.exec("ALTER TABLE work_lane_claims ADD COLUMN operation_id TEXT")
      database.exec("ALTER TABLE work_lane_claims ADD COLUMN phase TEXT")
      const update = database.prepare(
        "UPDATE work_lane_claims SET goal_id = ?, operation_id = ?, phase = ?, record = ? WHERE lane_id = ?"
      )
      for (const lane of lanes) update.run(lane.goalId, lane.operationId, lane.phase, JSON.stringify(lane), lane.laneId)
    }
    if (decisionColumns.length > 0 && !decisionColumns.includes("session_id")) {
      database.exec("ALTER TABLE work_decision_handoffs ADD COLUMN session_id TEXT")
      const update = database.prepare(
        "UPDATE work_decision_handoffs SET session_id = ?, record = ? WHERE handoff_id = ?"
      )
      for (const decision of decisions) update.run(decision.sessionId, JSON.stringify(decision), decision.id)
      if (dispatches.length > 0) {
        const updateDispatch = database.prepare(
          "UPDATE work_dispatch_handoffs SET record = ? WHERE dispatch_request_id = ?"
        )
        const updateMetadata = tables.includes("orchestrator_dispatch_metadata")
          ? database.prepare(
            "UPDATE orchestrator_dispatch_metadata SET work_link = ? WHERE dispatch_request_id = ?"
          )
          : null
        for (const dispatch of dispatches) {
          const decision = decisions.find(({ id }) => id === dispatch.handoffId)
          if (decision === undefined) continue
          updateDispatch.run(JSON.stringify(decision), dispatch.dispatchRequestId)
          updateMetadata?.run(
            JSON.stringify({ handoff: decision, lineage: decision.dispatchIds }),
            dispatch.dispatchRequestId
          )
        }
      }
    }
    if (decisionColumns.length > 0) {
      const storedDecisions = Schema.decodeUnknownSync(Schema.Array(DecisionRow))(
        database.prepare(
          `SELECT handoff_id AS handoffId, session_id AS sessionId, lane_id AS laneId,
             occurred_at AS occurredAt, record
           FROM work_decision_handoffs`
        ).all()
      )
      const updateDecision = database.prepare(
        "UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?"
      )
      const updateDispatch = tables.includes("work_dispatch_handoffs")
        ? database.prepare("UPDATE work_dispatch_handoffs SET record = ? WHERE handoff_id = ?")
        : null
      const updateMetadata = tables.includes("orchestrator_dispatch_metadata")
        ? database.prepare(
          `UPDATE orchestrator_dispatch_metadata SET work_link = ?
           WHERE dispatch_request_id = ?`
        )
        : null
      const previousDecisions = storedDecisions.flatMap((row) => {
        const input = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(row.record)
        const previous = decodePreviousDecisionHandoff(input)
        const handoffDispatches = tables.includes("work_dispatch_handoffs")
          ? Schema.decodeUnknownSync(Schema.Array(LegacyDispatchStoredRow))(
            database.prepare(
              `SELECT dispatch_request_id AS dispatchRequestId, handoff_id AS handoffId,
                 lane_id AS laneId, occurred_at AS occurredAt, lineage, record
               FROM work_dispatch_handoffs WHERE handoff_id = ?`
            ).all(row.handoffId)
          )
          : []
        switch (previous._tag) {
          case "current": {
            if (
              previous.value.id !== row.handoffId || previous.value.sessionId !== row.sessionId ||
              previous.value.laneId !== row.laneId || previous.value.occurredAt !== row.occurredAt
            ) {
              throw new WorkStoreError({
                cause: { handoff: previous.value, row },
                operation: "open.migrate.handoff-identity"
              })
            }
            if (handoffDispatches.length > 1) {
              throw new WorkStoreError({
                cause: { handoffDispatches, row },
                operation: "open.migrate.dispatch-cardinality"
              })
            }
            const linkedMetadata = tables.includes("orchestrator_dispatch_metadata")
              ? Schema.decodeUnknownSync(Schema.Array(MetadataWorkLinkRow))(
                database.prepare(
                  `SELECT dispatch_request_id AS dispatchRequestId, route, work_link AS workLink
                   FROM orchestrator_dispatch_metadata
                   WHERE work_link IS NOT NULL
                     AND CASE WHEN json_valid(work_link)
                       THEN json_extract(work_link, '$.handoff.id') END = ?`
                ).all(row.handoffId)
              )
              : []
            if (
              tables.includes("orchestrator_dispatch_metadata") &&
              (linkedMetadata.length !== handoffDispatches.length ||
                linkedMetadata.some((metadata) =>
                  !handoffDispatches.some(({ dispatchRequestId }) => dispatchRequestId === metadata.dispatchRequestId)
                ))
            ) {
              throw new WorkStoreError({
                cause: { handoffDispatches, linkedMetadata, row },
                operation: "open.migrate.metadata-authority"
              })
            }
            for (const dispatch of handoffDispatches) {
              const dispatchAuthority = (() => {
                try {
                  return {
                    handoff: Schema.decodeUnknownSync(WorkDecisionHandoff)(JSON.parse(dispatch.record)),
                    lineage: Schema.decodeUnknownSync(WorkDispatchHandoff.fields.lineage)(JSON.parse(dispatch.lineage))
                  }
                } catch (cause) {
                  throw new WorkStoreError({ cause, operation: "open.migrate.decode-dispatch-authority" })
                }
              })()
              if (
                dispatch.laneId !== previous.value.laneId ||
                dispatch.occurredAt !== previous.value.occurredAt ||
                !currentDecisionHandoffEquivalent(dispatchAuthority.handoff, previous.value) ||
                !workDispatchLineageContainedBy(dispatchAuthority.lineage, previous.value.dispatchIds)
              ) {
                throw new WorkStoreError({
                  cause: { dispatch, dispatchAuthority, handoff: previous.value },
                  operation: "open.migrate.dispatch-authority"
                })
              }
              if (!tables.includes("orchestrator_dispatch_metadata")) continue
              const metadata = linkedMetadata.find(({ dispatchRequestId }) =>
                dispatchRequestId === dispatch.dispatchRequestId
              )
              if (metadata?.workLink === null || metadata?.workLink === undefined) {
                throw new WorkStoreError({
                  cause: { dispatch, metadata },
                  operation: "open.migrate.metadata-authority"
                })
              }
              const workLink = (() => {
                try {
                  return Schema.decodeUnknownSync(CurrentMetadataWorkLink)(JSON.parse(metadata.workLink))
                } catch (cause) {
                  throw new WorkStoreError({ cause, operation: "open.migrate.decode-metadata-authority" })
                }
              })()
              requireMetadataAuthority(
                dispatch.dispatchRequestId,
                metadata.route,
                workLink.lineage,
                "open.migrate.metadata-authority"
              )
              if (
                !currentDecisionHandoffEquivalent(workLink.handoff, previous.value) ||
                !workDispatchLineageEquivalent(workLink.lineage, dispatchAuthority.lineage)
              ) {
                throw new WorkStoreError({
                  cause: { handoff: previous.value, workLink },
                  operation: "open.migrate.metadata-authority"
                })
              }
              requireCurrentAgentBindingAuthority(
                dispatch.dispatchRequestId,
                previous.value,
                "open.migrate.current-agent-binding"
              )
            }
            return []
          }
          case "invalid":
            throw new WorkStoreError({
              cause: previous.cause,
              operation: "open.migrate.invalid-handoff"
            })
          case "previous":
            return [{ previous: previous.value, row }]
        }
      })
      for (const { previous, row } of previousDecisions) {
        Schema.decodeUnknownSync(LaneRevisionRow)(
          database.prepare("SELECT revision FROM work_lane_claims WHERE lane_id = ?").get(row.laneId)
        )
        const handoffDispatches = tables.includes("work_dispatch_handoffs")
          ? Schema.decodeUnknownSync(Schema.Array(LegacyDispatchStoredRow))(
            database.prepare(
              `SELECT dispatch_request_id AS dispatchRequestId, handoff_id AS handoffId,
                 lane_id AS laneId, occurred_at AS occurredAt, lineage, record
               FROM work_dispatch_handoffs WHERE handoff_id = ?`
            ).all(row.handoffId)
          )
          : []
        if (handoffDispatches.length > 1) {
          throw new WorkStoreError({
            cause: { handoffDispatches, row },
            operation: "open.migrate.dispatch-cardinality"
          })
        }
        const linkedMetadata = tables.includes("orchestrator_dispatch_metadata")
          ? Schema.decodeUnknownSync(Schema.Array(MetadataWorkLinkRow))(
            database.prepare(
              `SELECT dispatch_request_id AS dispatchRequestId, route, work_link AS workLink
               FROM orchestrator_dispatch_metadata
               WHERE work_link IS NOT NULL
                 AND CASE WHEN json_valid(work_link)
                   THEN json_extract(work_link, '$.handoff.id') END = ?`
            ).all(row.handoffId)
          )
          : []
        if (
          linkedMetadata.length !== handoffDispatches.length ||
          linkedMetadata.some((metadata) =>
            !handoffDispatches.some(({ dispatchRequestId }) => dispatchRequestId === metadata.dispatchRequestId)
          )
        ) {
          throw new WorkStoreError({
            cause: { handoffDispatches, linkedMetadata, row },
            operation: "open.migrate.metadata-authority"
          })
        }
        const bindingRows = tables.includes("work_agent_bindings") && tables.includes("work_dispatch_handoffs")
          ? Schema.decodeUnknownSync(Schema.Array(AgentBindingRow))(
            database.prepare(
              `SELECT binding.dispatch_request_id AS dispatchRequestId, binding.lane_id AS laneId,
                 binding.expected_revision AS expectedRevision, binding.revision,
                 binding.agent_id AS agentId, binding.host, binding.record
               FROM work_agent_bindings binding
               JOIN work_dispatch_handoffs dispatch
                 ON dispatch.dispatch_request_id = binding.dispatch_request_id
               WHERE dispatch.handoff_id = ?`
            ).all(row.handoffId)
          )
          : []
        const bindingRow = bindingRows[0]
        const handoffDispatch = bindingRow === undefined
          ? undefined
          : handoffDispatches.find(({ dispatchRequestId }) => dispatchRequestId === bindingRow.dispatchRequestId)
        if (bindingRows.length !== 1 || bindingRow === undefined || handoffDispatch === undefined) {
          throw new WorkStoreError({ cause: { bindingRows, row }, operation: "open.migrate.handoff-revision" })
        }
        const bindingDecision = decodeAgentBindingRow(
          bindingRow,
          { dispatchRequestId: handoffDispatch.dispatchRequestId, laneId: previous.laneId },
          "open.migrate.agent-binding"
        )
        if (bindingDecision._tag === "invalid") throw bindingDecision.error
        if (bindingDecision.binding.lane.goalId !== previous.goalId) {
          throw new WorkStoreError({
            cause: { binding: bindingDecision.binding, previous },
            operation: "open.migrate.agent-binding.goal"
          })
        }
        requireBindingCompanions(bindingDecision.binding, "open.migrate.agent-binding")
        requireLifecycleAuthority(
          bindingDecision.binding.request.dispatchRequestId,
          bindingDecision.binding.checkpoint.occurredAt,
          "open.migrate.agent-binding.lifecycle"
        )
        const verifiedDispatches = handoffDispatches.map((dispatch) => {
          const dispatchHandoff = Schema.decodeUnknownSync(PreviousWorkDecisionHandoff)(JSON.parse(dispatch.record))
          const lineage = Schema.decodeUnknownSync(WorkDispatchHandoff.fields.lineage)(JSON.parse(dispatch.lineage))
          if (
            dispatch.laneId !== previous.laneId || dispatch.occurredAt !== previous.occurredAt ||
            !previousDecisionHandoffEquivalent(dispatchHandoff, previous) ||
            !workDispatchLineageContainedBy(lineage, previous.dispatchIds)
          ) {
            throw new WorkStoreError({
              cause: { dispatch, dispatchHandoff, previous },
              operation: "open.migrate.dispatch-authority"
            })
          }
          if (tables.includes("orchestrator_dispatch_metadata")) {
            const metadata = linkedMetadata.find(({ dispatchRequestId }) =>
              dispatchRequestId === dispatch.dispatchRequestId
            )
            if (metadata?.workLink === null || metadata?.workLink === undefined) {
              throw new WorkStoreError({
                cause: { dispatch, metadata },
                operation: "open.migrate.metadata-authority"
              })
            }
            const workLink = Schema.decodeUnknownSync(PreviousMetadataWorkLink)(JSON.parse(metadata.workLink))
            requireMetadataAuthority(
              dispatch.dispatchRequestId,
              metadata.route,
              workLink.lineage,
              "open.migrate.metadata-authority"
            )
            if (
              !previousDecisionHandoffEquivalent(workLink.handoff, previous) ||
              !workDispatchLineageEquivalent(workLink.lineage, lineage)
            ) {
              throw new WorkStoreError({
                cause: { previous, workLink },
                operation: "open.migrate.metadata-authority"
              })
            }
          }
          return { dispatch, lineage }
        })
        const migrated = upgradePreviousDecisionHandoff(
          previous,
          bindingDecision.binding.request.expectedRevision
        )
        if (
          migrated.id !== row.handoffId || migrated.sessionId !== row.sessionId ||
          migrated.laneId !== row.laneId || migrated.occurredAt !== row.occurredAt
        ) {
          throw new WorkStoreError({ cause: { migrated, row }, operation: "open.migrate.handoff-identity" })
        }
        const encoded = JSON.stringify(migrated)
        updateDecision.run(encoded, row.handoffId)
        updateDispatch?.run(encoded, row.handoffId)
        for (const { dispatch, lineage } of verifiedDispatches) {
          updateMetadata?.run(
            JSON.stringify({ handoff: migrated, lineage }),
            dispatch.dispatchRequestId
          )
        }
      }
      if (decisions.length > 0 || previousDecisions.length > 0) {
        const migratedLedger = Schema.decodeUnknownSync(LedgerBytesRow)(
          database.prepare(
            `SELECT COALESCE(SUM(
               length(CAST(handoff_id AS BLOB)) + length(CAST(record AS BLOB))
             ), 0) AS bytes
             FROM work_decision_handoffs`
          ).get()
        )
        if (migratedLedger.bytes > workDecisionMaxBytes) {
          throw new WorkStoreError({
            cause: migratedLedger,
            operation: "open.migrate.handoff-capacity"
          })
        }
      }
    }
    database.exec("COMMIT")
    transaction = false
  } catch (error) {
    if (transaction) database.exec("ROLLBACK")
    throw error
  }
}

const verifyPathIdentity = (
  path: string,
  fileSystem: FileSystem.FileSystem,
  paths: Path.Path,
  operation: string
): Effect.Effect<void, WorkStoreError> =>
  fileSystem.readLink(path).pipe(
    Effect.matchEffect({
      onFailure: (cause) =>
        cause.reason._tag === "NotFound" || cause.reason._tag === "Unknown"
          ? Effect.void
          : Effect.fail(new WorkStoreError({ cause, operation: `${operation}.readlink` })),
      onSuccess: (target) => Effect.fail(new WorkStoreError({ cause: { path, target }, operation }))
    }),
    Effect.andThen(fileSystem.exists(path).pipe(Effect.mapError(storeError(`${operation}.exists`)))),
    Effect.flatMap((exists) => {
      if (!exists) {
        const parent = paths.dirname(path)
        return parent === path ? Effect.void : verifyPathIdentity(parent, fileSystem, paths, operation)
      }
      const parent = paths.dirname(path)
      return Effect.all({
        realPath: fileSystem.realPath(path).pipe(Effect.mapError(storeError(`${operation}.realpath`))),
        realParentPath: fileSystem.realPath(parent).pipe(Effect.mapError(storeError(`${operation}.parent-realpath`)))
      }).pipe(Effect.flatMap(({ realParentPath, realPath }) => {
        const expectedPath = paths.join(realParentPath, paths.basename(path))
        return realPath === expectedPath
          ? Effect.void
          : Effect.fail(new WorkStoreError({ cause: { expectedPath, path, realPath }, operation }))
      }))
    })
  )
const readTransactionLedgerTotals = (database: DatabaseSync) =>
  Schema.decodeUnknownSync(TransactionLedgerTotalsRow)(
    database.prepare(
      `SELECT transaction_count AS transactionCount, transaction_bytes AS transactionBytes
       FROM work_goal_transaction_totals WHERE singleton = 1`
    ).get()
  )
const readDecisionLedgerTotals = (database: DatabaseSync) =>
  Schema.decodeUnknownSync(DecisionLedgerTotalsRow)(
    database.prepare(
      `SELECT decision_count AS decisionCount, decision_bytes AS decisionBytes
       FROM work_decision_totals WHERE singleton = 1`
    ).get()
  )
const readLaneOperationLedgerTotals = (database: DatabaseSync) =>
  Schema.decodeUnknownSync(LaneOperationLedgerTotalsRow)(
    database.prepare(
      `SELECT operation_count AS operationCount, operation_bytes AS operationBytes
       FROM work_lane_operation_totals WHERE singleton = 1`
    ).get()
  )
type AppendRejection = WorkCheckpointConflictError | WorkProjectionError
type AppendDecision =
  | { readonly _tag: "inserted"; readonly changes: bigint | number }
  | { readonly _tag: "replayed"; readonly event: WorkGoalCheckpointType }
  | { readonly _tag: "rejected"; readonly error: AppendRejection }

type AppendManyDecision =
  | { readonly _tag: "inserted"; readonly events: ReadonlyArray<WorkGoalCheckpointType> }
  | { readonly _tag: "replayed"; readonly events: ReadonlyArray<WorkGoalCheckpointType> }
  | {
    readonly _tag: "rejected"
    readonly error: AppendRejection | WorkTransactionConflictError | WorkStoreError
  }

type ClaimDecision =
  | { readonly _tag: "conflict"; readonly error: WorkLaneClaimConflictError }
  | { readonly _tag: "goal-conflict"; readonly error: WorkLaneGoalConflictError }
  | { readonly _tag: "operation-conflict"; readonly error: WorkLaneOperationConflictError }
  | { readonly _tag: "rejected"; readonly error: WorkProjectionError | WorkStoreError }
  | { readonly _tag: "claimed"; readonly value: WorkLaneClaimed }

type AgentBindingDecision =
  | { readonly _tag: "bound"; readonly binding: WorkAgentBindingType }
  | {
    readonly _tag: "rejected"
    readonly error:
      | WorkAgentBindingAuthorityError
      | WorkAgentBindingConflictError
      | WorkProjectionError
      | WorkStoreError
  }

type HandoffDecision =
  | { readonly _tag: "coordinator-conflict"; readonly error: WorkCoordinatorHandoffConflictError }
  | { readonly _tag: "conflict"; readonly error: WorkDecisionHandoffConflictError }
  | { readonly _tag: "replayed"; readonly value: WorkDecisionHandoffType }
  | { readonly _tag: "inserted"; readonly value: WorkDecisionHandoffType }
  | {
    readonly _tag: "rejected"
    readonly error:
      | WorkDecisionAuthorityConflictError
      | WorkDecisionRevisionConflictError
      | WorkProjectionError
      | WorkStoreError
  }

const utf8 = new TextEncoder()
const encodedBytes = (value: typeof Schema.Json.Type): number => utf8.encode(JSON.stringify(value)).byteLength
const maximumTimestamp = 8_640_000_000_000_000
const workTransactionMaxRecords = 16_384
const workTransactionMaxBytes = 2 * 1024 * 1024
const workLaneMaxRecords = workSnapshotMaxGoals
const workLaneMaxBytes = 2 * 1024 * 1024
const workLaneOperationMaxRecords = workAgentBindingLaneOperationMaxRecords
const workLaneOperationMaxBytes = workAgentBindingLaneOperationMaxBytes
const workDecisionMaxRecords = 16_384
const workDecisionMaxBytes = 2 * 1024 * 1024
const workStoreBusyTimeoutMillis = 5_000
const workSnapshotEnvelopeMaxBytes = workAgentBindingSnapshotEnvelopeMaxBytes
const maximumSnapshotBytes = workAgentBindingMaximumSnapshotBytes

const transactionContent = (events: ReadonlyArray<WorkGoalCheckpointType>) => JSON.stringify(events)

export const __herdrWorkMaximumSnapshotBytesForTest = maximumSnapshotBytes
export const __herdrWorkEncodedBytesForTest = encodedBytes
export const __herdrWorkSnapshotEnvelopeMaxBytesForTest = workSnapshotEnvelopeMaxBytes
export const __herdrWorkLaneOperationMaxBytesForTest = workLaneOperationMaxBytes

const decodeRow = (row: Readonly<Record<string, SQLOutputValue>>) =>
  Schema.decodeUnknownEffect(StoredEventRow)(row).pipe(
    Effect.mapError(storeError("decode.row")),
    Effect.flatMap(({ record }) =>
      Effect.try({
        try: () => Schema.decodeUnknownSync(WorkGoalCheckpoint)(JSON.parse(record)),
        catch: storeError("decode.event")
      })
    )
  )

const claimInputFromClaimed = (claim: WorkLaneClaimed): WorkLaneClaim => ({
  branch: claim.branch,
  expectedRevision: claim.expectedRevision,
  goalId: claim.goalId,
  head: claim.head,
  laneId: claim.laneId,
  operationId: claim.operationId,
  owner: claim.owner,
  parent: claim.parent,
  phase: claim.phase,
  worktree: claim.worktree
})

type ValidatedLaneEntry = {
  readonly claim: WorkLaneClaimed
  readonly row: typeof LaneRow.Type
}
type ValidatedLaneLedger =
  | { readonly _tag: "invalid"; readonly error: WorkStoreError }
  | { readonly _tag: "valid"; readonly entries: ReadonlyArray<ValidatedLaneEntry> }

const readValidatedLaneLedger = (
  database: DatabaseSync,
  operation: string
): ValidatedLaneLedger => {
  try {
    const rows = Schema.decodeUnknownSync(Schema.Array(LaneRow))(
      database.prepare(
        `SELECT lane_id AS laneId, goal_id AS goalId, operation_id AS operationId,
           phase, revision, record
         FROM work_lane_claims ORDER BY lane_id ASC LIMIT ?`
      ).all(workLaneMaxRecords + 1)
    )
    if (rows.length > workLaneMaxRecords) {
      return {
        _tag: "invalid",
        error: new WorkStoreError({ cause: rows.length, operation: `${operation}.capacity` })
      }
    }
    const entries: Array<ValidatedLaneEntry> = []
    for (const row of rows) {
      const claim = Schema.decodeUnknownSync(WorkLaneClaimed)(JSON.parse(row.record))
      if (
        claim.goalId !== row.goalId ||
        claim.laneId !== row.laneId ||
        claim.operationId !== row.operationId ||
        claim.phase !== row.phase ||
        claim.revision !== row.revision
      ) {
        return {
          _tag: "invalid",
          error: new WorkStoreError({ cause: { claim, row }, operation: `${operation}.identity-mismatch` })
        }
      }
      entries.push({ claim, row })
    }
    return { _tag: "valid", entries }
  } catch (cause) {
    return { _tag: "invalid", error: new WorkStoreError({ cause, operation: `${operation}.decode` }) }
  }
}

export interface WorkStoreService {
  readonly bindAgent: (
    request: WorkAgentBindingRequestType
  ) => Effect.Effect<
    WorkAgentBindingType,
    WorkAgentBindingAuthorityError | WorkAgentBindingConflictError | WorkProjectionError | WorkStoreError
  >
  readonly agentBinding: (
    dispatchRequestId: string
  ) => Effect.Effect<Option.Option<WorkAgentBindingType>, WorkStoreError>
  readonly append: (
    event: WorkGoalCheckpointType
  ) => Effect.Effect<
    WorkGoalCheckpointType,
    WorkCheckpointConflictError | WorkProjectionError | WorkStoreError
  >
  readonly appendMany: (
    transactionId: string,
    events: ReadonlyArray<WorkGoalCheckpointType>
  ) => Effect.Effect<
    ReadonlyArray<WorkGoalCheckpointType>,
    | WorkCheckpointConflictError
    | WorkProjectionError
    | WorkTransactionConflictError
    | WorkStoreError
  >
  readonly claim: (
    claim: WorkLaneClaim
  ) => Effect.Effect<
    WorkLaneClaimed,
    | WorkLaneClaimConflictError
    | WorkLaneGoalConflictError
    | WorkLaneOperationConflictError
    | WorkProjectionError
    | WorkStoreError
  >
  readonly currentClaim: (
    laneId: string
  ) => Effect.Effect<Option.Option<WorkLaneClaimed>, WorkStoreError>
  readonly activeGoalClaim: (
    goalId: string
  ) => Effect.Effect<Option.Option<WorkLaneClaimed>, WorkStoreError>
  readonly decision: (
    handoff: WorkDecisionHandoff
  ) => Effect.Effect<
    WorkDecisionHandoff,
    | WorkCoordinatorHandoffConflictError
    | WorkDecisionAuthorityConflictError
    | WorkDecisionHandoffConflictError
    | WorkDecisionRevisionConflictError
    | WorkProjectionError
    | WorkStoreError
  >
  readonly coordinatorHandoff: (
    sessionId: string
  ) => Effect.Effect<Option.Option<WorkDecisionHandoff>, WorkStoreError>
  readonly decisions: (
    laneId: string
  ) => Effect.Effect<ReadonlyArray<WorkDecisionHandoff>, WorkStoreError>
  readonly list: () => Effect.Effect<ReadonlyArray<WorkGoalCheckpointType>, WorkStoreError>
  /** Atomically reads projection history and its coordinator-owned logical-time boundary. */
  readonly snapshotInput: () => Effect.Effect<{
    readonly events: ReadonlyArray<WorkGoalCheckpointType>
    readonly logicalObservedAt: number | null
  }, WorkStoreError>
}

export class WorkStore implements WorkStoreService {
  readonly #database: DatabaseSync
  readonly #cryptoService: Crypto.Crypto
  readonly #fileSystem: FileSystem.FileSystem
  readonly #paths: Path.Path
  readonly path: string

  private constructor(
    path: string,
    fileSystem: FileSystem.FileSystem,
    paths: Path.Path,
    cryptoService: Crypto.Crypto
  ) {
    this.path = path
    this.#fileSystem = fileSystem
    this.#paths = paths
    this.#cryptoService = cryptoService
    this.#database = new DatabaseSync(path)
    try {
      this.#database.exec(`PRAGMA busy_timeout = ${workStoreBusyTimeoutMillis}`)
      migrateLegacyAuthorityTables(this.#database)
      const hadLaneOperationLedger = this.#database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'work_lane_operations'"
      ).get() !== undefined
      this.#database.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS work_goal_events (
          event_id TEXT PRIMARY KEY,
          goal_id TEXT NOT NULL,
          occurred_at INTEGER NOT NULL,
          record TEXT NOT NULL,
          UNIQUE (goal_id, occurred_at)
        );
        CREATE TABLE IF NOT EXISTS work_agent_bindings (
          dispatch_request_id TEXT PRIMARY KEY,
          lane_id TEXT NOT NULL,
          expected_revision INTEGER NOT NULL,
          revision INTEGER NOT NULL,
          agent_id TEXT NOT NULL,
          host TEXT NOT NULL,
          record TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS work_agent_bindings_lane_revision
          ON work_agent_bindings (lane_id, revision);
        CREATE TABLE IF NOT EXISTS work_goal_transactions (
          transaction_id TEXT PRIMARY KEY,
          record TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS work_goal_transaction_totals (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          transaction_count INTEGER NOT NULL CHECK (transaction_count >= 0),
          transaction_bytes INTEGER NOT NULL CHECK (transaction_bytes >= 0)
        );
        CREATE TRIGGER IF NOT EXISTS work_goal_transactions_after_insert
        AFTER INSERT ON work_goal_transactions
        BEGIN
          UPDATE work_goal_transaction_totals
          SET transaction_count = transaction_count + 1,
              transaction_bytes = transaction_bytes +
                length(CAST(NEW.transaction_id AS BLOB)) + length(CAST(NEW.record AS BLOB))
          WHERE singleton = 1;
        END;
        CREATE TABLE IF NOT EXISTS work_lane_claims (
          lane_id TEXT PRIMARY KEY,
          goal_id TEXT NOT NULL,
          operation_id TEXT NOT NULL UNIQUE,
          phase TEXT NOT NULL,
          revision INTEGER NOT NULL,
          record TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS work_lane_claims_one_active_goal
          ON work_lane_claims (goal_id)
          WHERE phase <> 'shipped';
        CREATE TABLE IF NOT EXISTS work_lane_operations (
          operation_id TEXT PRIMARY KEY,
          lane_id TEXT NOT NULL,
          goal_id TEXT NOT NULL,
          phase TEXT NOT NULL,
          revision INTEGER NOT NULL,
          record TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS work_lane_operations_lane_revision
          ON work_lane_operations (lane_id, revision);
        CREATE TABLE IF NOT EXISTS work_lane_operation_totals (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          operation_count INTEGER NOT NULL CHECK (operation_count >= 0),
          operation_bytes INTEGER NOT NULL CHECK (operation_bytes >= 0)
        );
        CREATE TRIGGER IF NOT EXISTS work_lane_operations_after_insert
        AFTER INSERT ON work_lane_operations
        BEGIN
          UPDATE work_lane_operation_totals
          SET operation_count = operation_count + 1,
              operation_bytes = operation_bytes +
                length(CAST(NEW.operation_id AS BLOB)) + length(CAST(NEW.record AS BLOB))
          WHERE singleton = 1;
        END;
        CREATE TABLE IF NOT EXISTS work_decision_handoffs (
          handoff_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL UNIQUE,
          lane_id TEXT NOT NULL,
          occurred_at INTEGER NOT NULL,
          record TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS work_decision_totals (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          decision_count INTEGER NOT NULL CHECK (decision_count >= 0),
          decision_bytes INTEGER NOT NULL CHECK (decision_bytes >= 0)
        );
        CREATE TRIGGER IF NOT EXISTS work_decision_handoffs_after_insert
        AFTER INSERT ON work_decision_handoffs
        BEGIN
          UPDATE work_decision_totals
          SET decision_count = decision_count + 1,
              decision_bytes = decision_bytes +
                length(CAST(NEW.handoff_id AS BLOB)) + length(CAST(NEW.record AS BLOB))
          WHERE singleton = 1;
        END;
        CREATE INDEX IF NOT EXISTS work_decision_handoffs_lane_time
          ON work_decision_handoffs (lane_id, occurred_at, handoff_id);
        CREATE INDEX IF NOT EXISTS work_decision_handoffs_session
          ON work_decision_handoffs (session_id);
      `)
      const columns = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))(
        this.#database.prepare("PRAGMA table_info(work_goal_events)").all()
      )
      if (!columns.some(({ name }) => name === "transaction_id")) {
        this.#database.exec("ALTER TABLE work_goal_events ADD COLUMN transaction_id TEXT")
      }
      if (!hadLaneOperationLedger) {
        this.#database.exec(`
          INSERT OR IGNORE INTO work_lane_operations
            (operation_id, lane_id, goal_id, phase, revision, record)
          SELECT operation_id, lane_id, goal_id, phase, revision, record
          FROM work_lane_claims
        `)
      }
      this.#database.exec(`
        INSERT OR IGNORE INTO work_lane_operation_totals
          (singleton, operation_count, operation_bytes)
        SELECT 1, COUNT(*), COALESCE(SUM(
          length(CAST(operation_id AS BLOB)) + length(CAST(record AS BLOB))
        ), 0)
        FROM work_lane_operations
      `)
      this.#database.exec(`
        INSERT OR IGNORE INTO work_goal_transaction_totals
          (singleton, transaction_count, transaction_bytes)
        SELECT 1, COUNT(*), COALESCE(SUM(
          length(CAST(transaction_id AS BLOB)) + length(CAST(record AS BLOB))
        ), 0)
        FROM work_goal_transactions
      `)
      this.#database.exec(`
        INSERT OR REPLACE INTO work_decision_totals
          (singleton, decision_count, decision_bytes)
        SELECT 1, COUNT(*), COALESCE(SUM(
          length(CAST(handoff_id AS BLOB)) + length(CAST(record AS BLOB))
        ), 0)
        FROM work_decision_handoffs
      `)
    } catch (error) {
      this.#database.close()
      throw error
    }
  }

  static readonly open = Effect.fn("WorkStore.open")(function*(path: string) {
    const cryptoService = yield* Crypto.Crypto
    const fileSystem = yield* FileSystem.FileSystem
    const paths = yield* Path.Path
    const directory = paths.dirname(path)
    const directoryExists = yield* fileSystem.exists(directory).pipe(
      Effect.mapError(storeError("open.directory.exists"))
    )
    yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
      Effect.mapError(storeError("open.directory"))
    )
    if (!directoryExists) {
      yield* fileSystem.chmod(directory, 0o700).pipe(
        Effect.mapError(storeError("open.secureDirectory"))
      )
    }
    const directoryInfo = yield* fileSystem.stat(directory).pipe(Effect.mapError(storeError("open.directory.stat")))
    if (directoryInfo.type !== "Directory" || (paths.sep === "/" && (directoryInfo.mode & 0o022) !== 0)) {
      return yield* new WorkStoreError({
        cause: { directory, mode: directoryInfo.mode, type: directoryInfo.type },
        operation: "open.directory.unsafe"
      })
    }
    yield* verifyPathIdentity(directory, fileSystem, paths, "open.directory.path-identity")
    yield* Effect.forEach(
      [path, `${path}-wal`, `${path}-shm`],
      (file) =>
        verifyPathIdentity(file, fileSystem, paths, "open.path-identity").pipe(
          Effect.andThen(fileSystem.exists(file).pipe(Effect.mapError(storeError("open.file.exists")))),
          Effect.flatMap((exists) => {
            if (!exists) return Effect.void
            return fileSystem.stat(file).pipe(
              Effect.mapError(storeError("open.file.stat")),
              Effect.flatMap((info) =>
                info.type !== "File" || (paths.sep === "/" && (info.mode & 0o022) !== 0)
                  ? Effect.fail(
                    new WorkStoreError({
                      cause: { file, mode: info.mode, type: info.type },
                      operation: "open.file.unsafe"
                    })
                  )
                  : fileSystem.chmod(file, 0o600).pipe(Effect.mapError(storeError("open.file.secure")))
              )
            )
          })
        ),
      { discard: true }
    )
    const store = yield* Effect.try({
      try: () => new WorkStore(path, fileSystem, paths, cryptoService),
      catch: storeError("open.database")
    })
    yield* store.secureFiles()
    return store
  })

  readonly bindAgent = Effect.fn("WorkStore.bindAgent")(function*(
    this: WorkStore,
    request: WorkAgentBindingRequestType
  ) {
    const decoded = yield* Schema.decodeUnknownEffect(WorkAgentBindingRequest)(request).pipe(
      Effect.mapError(storeError("agent-binding.decode"))
    )
    const observedAt = yield* Clock.currentTimeMillis
    yield* this.secureFiles()
    const decision = yield* Effect.try({
      try: (): AgentBindingDecision => {
        let inTransaction = false
        try {
          this.#database.exec("BEGIN IMMEDIATE")
          inTransaction = true
          const reject = (
            error: WorkAgentBindingAuthorityError | WorkAgentBindingConflictError | WorkProjectionError | WorkStoreError
          ): AgentBindingDecision => {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return { _tag: "rejected", error }
          }
          const existingRaw = this.#database.prepare(
            `SELECT dispatch_request_id AS dispatchRequestId, lane_id AS laneId,
               expected_revision AS expectedRevision, revision, agent_id AS agentId, host, record
             FROM work_agent_bindings WHERE dispatch_request_id = ?`
          ).get(decoded.dispatchRequestId)
          if (existingRaw !== undefined) {
            const row = Schema.decodeUnknownSync(AgentBindingRow)(existingRaw)
            const binding = Schema.decodeUnknownSync(WorkAgentBinding)(JSON.parse(row.record))
            if (
              row.dispatchRequestId !== binding.request.dispatchRequestId ||
              row.laneId !== binding.request.laneId ||
              row.expectedRevision !== binding.request.expectedRevision ||
              row.revision !== binding.lane.revision ||
              row.agentId !== binding.request.worker.agentId ||
              row.host.toLowerCase() !== binding.request.worker.host.toLowerCase()
            ) {
              return reject(
                new WorkStoreError({
                  cause: { binding, row },
                  operation: "agent-binding.identity-mismatch"
                })
              )
            }
            const laneRow = this.#database.prepare(
              `SELECT operation_id AS operationId, lane_id AS laneId, goal_id AS goalId,
                 phase, revision, record
               FROM work_lane_operations WHERE operation_id = ?`
            ).get(binding.lane.operationId)
            const checkpointRow = this.#database.prepare(
              `SELECT event_id AS eventId, goal_id AS goalId, occurred_at AS occurredAt, record
               FROM work_goal_events WHERE event_id = ?`
            ).get(binding.checkpoint.eventId)
            const readbackError = agentBindingReadbackError(
              binding,
              laneRow === undefined ? undefined : Schema.decodeUnknownSync(AgentBindingLaneOperationRow)(laneRow),
              checkpointRow === undefined
                ? undefined
                : Schema.decodeUnknownSync(AgentBindingGoalEventRow)(checkpointRow),
              "agent-binding.replay"
            )
            if (readbackError !== undefined) return reject(readbackError)
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return Equal.equals(binding.request, decoded)
              ? { _tag: "bound", binding }
              : {
                _tag: "rejected",
                error: new WorkAgentBindingConflictError({ dispatchRequestId: decoded.dispatchRequestId })
              }
          }

          const laneLedger = readValidatedLaneLedger(this.#database, "agent-binding.authority")
          if (laneLedger._tag === "invalid") return reject(laneLedger.error)
          const lane = laneLedger.entries.find(({ claim }) => claim.laneId === decoded.laneId)?.claim
          if (lane === undefined) {
            return reject(
              new WorkAgentBindingAuthorityError({
                actualRevision: 0,
                expectedRevision: decoded.expectedRevision,
                laneId: decoded.laneId,
                reason: "missing_lane"
              })
            )
          }
          if (lane.revision !== decoded.expectedRevision) {
            return reject(
              new WorkAgentBindingAuthorityError({
                actualRevision: lane.revision,
                expectedRevision: decoded.expectedRevision,
                laneId: decoded.laneId,
                reason: "stale_revision"
              })
            )
          }
          if (lane.phase === "shipped") {
            return reject(
              new WorkAgentBindingAuthorityError({
                actualRevision: lane.revision,
                expectedRevision: decoded.expectedRevision,
                laneId: decoded.laneId,
                reason: "shipped_lane"
              })
            )
          }
          const activeGoalClaims = laneLedger.entries
            .map(({ claim }) => claim)
            .filter((claim) => claim.goalId === lane.goalId && claim.phase !== "shipped")
          if (activeGoalClaims.length !== 1 || activeGoalClaims[0]?.laneId !== lane.laneId) {
            return reject(
              new WorkStoreError({
                cause: { activeGoalClaims, lane },
                operation: "agent-binding.goal-authority-conflict"
              })
            )
          }
          const currentRaw = this.#database.prepare(
            `SELECT event_id AS eventId, goal_id AS goalId, occurred_at AS occurredAt, record
             FROM work_goal_events
             WHERE goal_id = ? ORDER BY occurred_at DESC, event_id DESC LIMIT 1`
          ).get(lane.goalId)
          if (currentRaw === undefined) {
            return reject(
              new WorkAgentBindingAuthorityError({
                actualRevision: lane.revision,
                expectedRevision: decoded.expectedRevision,
                laneId: decoded.laneId,
                reason: "missing_goal"
              })
            )
          }
          const currentDecision = decodeAgentBindingGoalEvent(
            Schema.decodeUnknownSync(AgentBindingGoalEventRow)(currentRaw),
            "agent-binding.current-goal"
          )
          if (currentDecision._tag === "invalid") return reject(currentDecision.error)
          const current = currentDecision.checkpoint
          if (current.goal.state === "completed") {
            return reject(
              new WorkAgentBindingAuthorityError({
                actualRevision: lane.revision,
                expectedRevision: decoded.expectedRevision,
                laneId: decoded.laneId,
                reason: "terminal_goal"
              })
            )
          }
          if (current.occurredAt > observedAt) {
            return reject(
              new WorkProjectionError({
                cause: { checkpoint: current, observedAt },
                detail: "work agent binding cannot advance beyond the observed clock",
                reason: "inconsistent_history"
              })
            )
          }
          if (current.occurredAt >= maximumTimestamp) {
            return reject(
              new WorkProjectionError({
                cause: current,
                detail: "work agent binding timestamp cannot advance",
                reason: "capacity_exceeded"
              })
            )
          }
          const occurredAt = Math.max(observedAt, current.occurredAt + 1)
          const binding = makeWorkAgentBinding(decoded, lane, current, occurredAt)
          const historyRows = Schema.decodeUnknownSync(Schema.Array(AgentBindingGoalEventRow))(
            this.#database.prepare(
              `SELECT event_id AS eventId, goal_id AS goalId, occurred_at AS occurredAt, record
               FROM work_goal_events ORDER BY occurred_at ASC, event_id ASC`
            ).all()
          )
          const history: Array<WorkGoalCheckpointType> = []
          for (const row of historyRows) {
            const historyDecision = decodeAgentBindingGoalEvent(row, "agent-binding.history")
            if (historyDecision._tag === "invalid") return reject(historyDecision.error)
            history.push(historyDecision.checkpoint)
          }
          const collision = this.#database.prepare(
            `SELECT record FROM work_goal_events
             WHERE event_id = ? OR (goal_id = ? AND occurred_at = ?)`
          ).get(binding.checkpoint.eventId, binding.checkpoint.goal.id, binding.checkpoint.occurredAt)
          if (collision !== undefined) {
            return reject(new WorkStoreError({ cause: collision, operation: "agent-binding.event-collision" }))
          }
          const operationTotals = readLaneOperationLedgerTotals(this.#database)
          const encodedLane = JSON.stringify(binding.lane)
          const operationBytes = utf8.encode(binding.lane.operationId).byteLength + utf8.encode(encodedLane).byteLength
          const admissionError = agentBindingAdmissionError({
            candidate: binding.checkpoint,
            candidateOperationBytes: operationBytes,
            history,
            operationBytes: operationTotals.operationBytes,
            operationCount: operationTotals.operationCount
          })
          if (admissionError !== undefined) return reject(admissionError)
          const laneChanges = this.#database.prepare(
            `UPDATE work_lane_claims
             SET operation_id = ?, revision = ?, record = ?
             WHERE lane_id = ? AND revision = ?`
          ).run(
            binding.lane.operationId,
            binding.lane.revision,
            encodedLane,
            decoded.laneId,
            decoded.expectedRevision
          ).changes
          if (laneChanges !== 1 && laneChanges !== 1n) {
            return reject(
              new WorkAgentBindingAuthorityError({
                actualRevision: lane.revision,
                expectedRevision: decoded.expectedRevision,
                laneId: decoded.laneId,
                reason: "stale_revision"
              })
            )
          }
          this.#database.prepare(
            `INSERT INTO work_lane_operations
               (operation_id, lane_id, goal_id, phase, revision, record)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(
            binding.lane.operationId,
            binding.lane.laneId,
            binding.lane.goalId,
            binding.lane.phase,
            binding.lane.revision,
            encodedLane
          )
          this.#database.prepare(
            `INSERT INTO work_goal_events (event_id, goal_id, occurred_at, record)
             VALUES (?, ?, ?, ?)`
          ).run(
            binding.checkpoint.eventId,
            binding.checkpoint.goal.id,
            binding.checkpoint.occurredAt,
            JSON.stringify(binding.checkpoint)
          )
          this.#database.prepare(
            `INSERT INTO work_agent_bindings
               (dispatch_request_id, lane_id, expected_revision, revision, agent_id, host, record)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(
            decoded.dispatchRequestId,
            decoded.laneId,
            decoded.expectedRevision,
            binding.lane.revision,
            decoded.worker.agentId,
            decoded.worker.host,
            JSON.stringify(binding)
          )
          this.#database.exec("COMMIT")
          inTransaction = false
          return { _tag: "bound", binding } satisfies AgentBindingDecision
        } catch (error) {
          if (inTransaction) this.#database.exec("ROLLBACK")
          throw error
        }
      },
      catch: storeError("agent-binding.write")
    })
    if (decision._tag === "rejected") return yield* decision.error
    return decision.binding
  })

  readonly agentBinding = Effect.fn("WorkStore.agentBinding")(function*(
    this: WorkStore,
    dispatchRequestId: string
  ) {
    const decodedId = yield* Schema.decodeUnknownEffect(WorkAgentBindingRequest.fields.dispatchRequestId)(
      dispatchRequestId
    ).pipe(Effect.mapError(storeError("agent-binding.read.decode")))
    const raw = yield* Effect.try({
      try: () =>
        this.#database.prepare(
          `SELECT dispatch_request_id AS dispatchRequestId, lane_id AS laneId,
           expected_revision AS expectedRevision, revision, agent_id AS agentId, host, record
         FROM work_agent_bindings WHERE dispatch_request_id = ?`
        ).get(decodedId),
      catch: storeError("agent-binding.read")
    })
    if (raw === undefined) return Option.none<WorkAgentBindingType>()
    const row = yield* Schema.decodeUnknownEffect(AgentBindingRow)(raw).pipe(
      Effect.mapError(storeError("agent-binding.read.row"))
    )
    const binding = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(WorkAgentBinding)(JSON.parse(row.record)),
      catch: storeError("agent-binding.read.record")
    })
    if (
      row.dispatchRequestId !== binding.request.dispatchRequestId ||
      row.laneId !== binding.request.laneId ||
      row.expectedRevision !== binding.request.expectedRevision ||
      row.revision !== binding.lane.revision ||
      row.agentId !== binding.request.worker.agentId ||
      row.host.toLowerCase() !== binding.request.worker.host.toLowerCase()
    ) {
      return yield* new WorkStoreError({ cause: { binding, row }, operation: "agent-binding.read.identity-mismatch" })
    }
    const companions = yield* Effect.try({
      try: () => ({
        checkpoint: this.#database.prepare(
          `SELECT event_id AS eventId, goal_id AS goalId, occurred_at AS occurredAt, record
           FROM work_goal_events WHERE event_id = ?`
        ).get(binding.checkpoint.eventId),
        lane: this.#database.prepare(
          `SELECT operation_id AS operationId, lane_id AS laneId, goal_id AS goalId,
             phase, revision, record
           FROM work_lane_operations WHERE operation_id = ?`
        ).get(binding.lane.operationId)
      }),
      catch: storeError("agent-binding.read.companions")
    })
    const readbackError = agentBindingReadbackError(
      binding,
      companions.lane === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(AgentBindingLaneOperationRow)(companions.lane).pipe(
          Effect.mapError(storeError("agent-binding.read.lane-companion"))
        ),
      companions.checkpoint === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(AgentBindingGoalEventRow)(companions.checkpoint).pipe(
          Effect.mapError(storeError("agent-binding.read.checkpoint-companion"))
        ),
      "agent-binding.readback"
    )
    if (readbackError !== undefined) return yield* readbackError
    return Option.some(binding)
  })

  readonly append = Effect.fn("WorkStore.append")(function*(
    this: WorkStore,
    event: WorkGoalCheckpointType
  ) {
    const decoded = yield* Schema.decodeUnknownEffect(WorkGoalCheckpoint)(event).pipe(
      Effect.mapError(storeError("append.decode"))
    )
    yield* this.secureFiles()
    const decision = yield* Effect.try({
      try: () => {
        let transaction = false
        try {
          this.#database.exec("BEGIN IMMEDIATE")
          transaction = true
          const reject = (error: AppendRejection): AppendDecision => {
            this.#database.exec("ROLLBACK")
            transaction = false
            return { _tag: "rejected", error }
          }
          const collisions = Schema.decodeUnknownSync(StoredEventRows)(
            this.#database
              .prepare(
                `SELECT record FROM work_goal_events
                 WHERE event_id = ? OR (goal_id = ? AND occurred_at = ?)`
              )
              .all(decoded.eventId, decoded.goal.id, decoded.occurredAt)
          ).map(({ record }) => Schema.decodeUnknownSync(WorkGoalCheckpoint)(JSON.parse(record)))
          if (collisions.length > 0) {
            if (collisions.every((existing) => Equal.equals(existing, decoded))) {
              this.#database.exec("ROLLBACK")
              transaction = false
              return { _tag: "replayed", event: decoded } satisfies AppendDecision
            }
            return reject(
              new WorkCheckpointConflictError({
                eventId: decoded.eventId,
                goalId: decoded.goal.id,
                occurredAt: decoded.occurredAt
              })
            )
          }
          const eventCount = Schema.decodeUnknownSync(CountRow)(
            this.#database.prepare("SELECT COUNT(*) AS count FROM work_goal_events").get()
          ).count
          if (eventCount >= workHistoryMaxEvents) {
            return reject(
              new WorkProjectionError({
                cause: decoded,
                detail: `work history cannot exceed ${workHistoryMaxEvents} checkpoints`,
                reason: "capacity_exceeded"
              })
            )
          }
          const history = Schema.decodeUnknownSync(StoredEventRows)(
            this.#database.prepare("SELECT record FROM work_goal_events").all()
          ).map(({ record }) => Schema.decodeUnknownSync(WorkGoalCheckpoint)(JSON.parse(record)))
          const familyError = validateGoalFamilyHistory([...history, decoded])
          if (familyError !== undefined) return reject(familyError)
          if (maximumSnapshotBytes(history, decoded) > fleetResponseBodyMaxBytes) {
            return reject(
              new WorkProjectionError({
                cause: decoded,
                detail: `work snapshots cannot exceed ${fleetResponseBodyMaxBytes} encoded bytes`,
                reason: "capacity_exceeded"
              })
            )
          }
          const firstGoalRow = this.#database.prepare(
            "SELECT record FROM work_goal_events WHERE goal_id = ? ORDER BY occurred_at ASC, event_id ASC LIMIT 1"
          ).get(decoded.goal.id)
          if (firstGoalRow === undefined) {
            if (decoded.occurredAt !== decoded.goal.createdAt) {
              return reject(
                new WorkProjectionError({
                  cause: decoded,
                  detail: `goal ${decoded.goal.id} must begin at its creation timestamp`,
                  reason: "inconsistent_history"
                })
              )
            }
            const goalCount = Schema.decodeUnknownSync(CountRow)(
              this.#database.prepare("SELECT COUNT(DISTINCT goal_id) AS count FROM work_goal_events").get()
            ).count
            if (goalCount >= workSnapshotMaxGoals) {
              return reject(
                new WorkProjectionError({
                  cause: decoded,
                  detail: `work snapshots cannot exceed ${workSnapshotMaxGoals} goals`,
                  reason: "capacity_exceeded"
                })
              )
            }
          } else {
            const firstGoal = Schema.decodeUnknownSync(WorkGoalCheckpoint)(
              JSON.parse(Schema.decodeUnknownSync(StoredEventRow)(firstGoalRow).record)
            )
            if (firstGoal.goal.createdAt !== decoded.goal.createdAt) {
              return reject(
                new WorkProjectionError({
                  cause: decoded,
                  detail: `goal ${decoded.goal.id} changed its creation timestamp`,
                  reason: "inconsistent_history"
                })
              )
            }
          }
          const result = this.#database.prepare(
            "INSERT INTO work_goal_events (event_id, goal_id, occurred_at, record) VALUES (?, ?, ?, ?)"
          ).run(decoded.eventId, decoded.goal.id, decoded.occurredAt, JSON.stringify(decoded))
          this.#database.exec("COMMIT")
          transaction = false
          return { _tag: "inserted", changes: result.changes } satisfies AppendDecision
        } catch (error) {
          if (transaction) this.#database.exec("ROLLBACK")
          throw error
        }
      },
      catch: storeError("append.insert")
    })
    if (decision._tag === "rejected") return yield* decision.error
    if (decision._tag === "replayed") return decision.event
    if (decision.changes !== 1 && decision.changes !== 1n) {
      return yield* storeError("append.insert.count")(decision.changes)
    }
    return decoded
  })

  readonly appendMany = Effect.fn("WorkStore.appendMany")(function*(
    this: WorkStore,
    transactionId: string,
    events: ReadonlyArray<WorkGoalCheckpointType>
  ) {
    if (events.length > workHistoryMaxEvents) {
      return yield* new WorkProjectionError({
        cause: events.length,
        detail: `work history cannot exceed ${workHistoryMaxEvents} checkpoints`,
        reason: "capacity_exceeded"
      })
    }
    const transaction = yield* Schema.decodeUnknownEffect(TransactionId)(transactionId).pipe(
      Effect.mapError(storeError("appendMany.decode.transaction"))
    )
    const decoded = yield* Effect.forEach(events, (event) =>
      Schema.decodeUnknownEffect(WorkGoalCheckpoint)(event).pipe(
        Effect.mapError(storeError("appendMany.decode.event"))
      ))
    if (decoded.length === 0) {
      return yield* new WorkProjectionError({
        cause: events,
        detail: "a checkpoint transaction must contain at least one event",
        reason: "malformed"
      })
    }
    const digest = yield* this.#cryptoService.digest(
      "SHA-256",
      new TextEncoder().encode(transactionContent(decoded))
    ).pipe(
      Effect.mapError(storeError("appendMany.digest")),
      Effect.map(Encoding.encodeHex)
    )
    const transactionRecord = JSON.stringify({ digest, version: "herdr.work.transaction.v3" })
    const transactionEntryBytes = utf8.encode(transaction).byteLength + utf8.encode(transactionRecord).byteLength
    yield* this.secureFiles()
    const decision = yield* Effect.try({
      try: () => {
        let inTransaction = false
        try {
          this.#database.exec("BEGIN IMMEDIATE")
          inTransaction = true
          const storedTransaction = this.#database.prepare(
            "SELECT record FROM work_goal_transactions WHERE transaction_id = ?"
          ).get(transaction)
          let compactTransaction: typeof CompactTransactionRecord.Type | undefined
          let legacyCompactTransaction: typeof LegacyCompactTransactionRecord.Type | undefined
          let unsupportedCompactTransaction = false
          let legacyTransaction: ReadonlyArray<WorkGoalCheckpointType> | undefined
          if (storedTransaction !== undefined) {
            const stored = Schema.decodeUnknownSync(TransactionRow)(storedTransaction)
            const previous = JSON.parse(stored.record)
            const compact = Schema.decodeUnknownResult(CompactTransactionRecord)(previous)
            if (compact._tag === "Success") {
              compactTransaction = compact.success
            } else {
              const legacyCompact = Schema.decodeUnknownResult(LegacyCompactTransactionRecord)(previous)
              if (legacyCompact._tag === "Success") {
                legacyCompactTransaction = legacyCompact.success
                unsupportedCompactTransaction = true
              } else {
                const previousCompact = Schema.decodeUnknownResult(PreviousCompactTransactionRecord)(previous)
                if (previousCompact._tag === "Success") {
                  unsupportedCompactTransaction = true
                } else {
                  legacyTransaction = Schema.decodeUnknownSync(Schema.Array(WorkGoalCheckpoint))(previous)
                }
              }
            }
          }

          const duplicateEventIds = new Set<string>()
          const duplicateGoalTimes = new Set<string>()
          for (const event of decoded) {
            const goalTime = `${event.goal.id}\u0000${event.occurredAt}`
            if (duplicateEventIds.has(event.eventId) || duplicateGoalTimes.has(goalTime)) {
              this.#database.exec("ROLLBACK")
              inTransaction = false
              return {
                _tag: "rejected",
                error: new WorkProjectionError({
                  cause: event,
                  detail: "a checkpoint transaction contains a duplicate event identity",
                  reason: "duplicate_event"
                })
              } satisfies AppendManyDecision
            }
            duplicateEventIds.add(event.eventId)
            duplicateGoalTimes.add(goalTime)
          }

          const rows = Schema.decodeUnknownSync(StoredEventWithTransactionRows)(
            this.#database.prepare(
              `SELECT event_id AS eventId, goal_id AS goalId, occurred_at AS occurredAt,
                record, transaction_id AS transactionId
               FROM work_goal_events`
            ).all()
          )
          const rowsByEventId = new Map(rows.map((row) => [row.eventId, row]))
          const rowsByGoalTime = new Map(rows.map((row) => [
            JSON.stringify([row.goalId, row.occurredAt]),
            row
          ]))
          const decodedRows = rows.map((row) => ({
            event: Schema.decodeUnknownSync(WorkGoalCheckpoint)(JSON.parse(row.record)),
            row
          }))
          const decodedEventsByEventId = new Map(decodedRows.map(({ event, row }) => [row.eventId, event]))
          if (legacyTransaction !== undefined) {
            const legacyRows = legacyTransaction.map((event) => rowsByEventId.get(event.eventId))
            if (
              legacyRows.some((row, index) => {
                const event = legacyTransaction[index]
                return row === undefined ||
                  event === undefined ||
                  row.goalId !== event.goal.id ||
                  row.occurredAt !== event.occurredAt
              })
            ) {
              this.#database.exec("ROLLBACK")
              inTransaction = false
              return {
                _tag: "rejected",
                error: new WorkTransactionConflictError({ transactionId: transaction })
              } satisfies AppendManyDecision
            }
            const legacyEvents = legacyRows.map((row) =>
              row === undefined
                ? undefined
                : Schema.decodeUnknownSync(WorkGoalCheckpoint)(JSON.parse(row.record))
            )
            if (
              legacyEvents.some((event) => event === undefined) ||
              legacyEvents.some((event, index) => event !== undefined && !Equal.equals(event, legacyTransaction[index]))
            ) {
              this.#database.exec("ROLLBACK")
              inTransaction = false
              return {
                _tag: "rejected",
                error: new WorkTransactionConflictError({ transactionId: transaction })
              } satisfies AppendManyDecision
            }
          }
          const existing = decoded.map((event) => {
            const row = rowsByEventId.get(event.eventId) ??
              rowsByGoalTime.get(JSON.stringify([event.goal.id, event.occurredAt]))
            return row === undefined
              ? undefined
              : decodedEventsByEventId.get(row.eventId)
          })
          const conflicting = existing.find(
            (candidate, index) => candidate !== undefined && !Equal.equals(candidate, decoded[index])
          )
          if (conflicting !== undefined) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            const index = existing.findIndex((candidate) => candidate === conflicting)
            const event = decoded[index]
            if (event === undefined) {
              return {
                _tag: "rejected",
                error: new WorkStoreError({
                  cause: decoded,
                  operation: "appendMany.collision-candidate"
                })
              } satisfies AppendManyDecision
            }
            return {
              _tag: "rejected",
              error: new WorkCheckpointConflictError({
                eventId: event.eventId,
                goalId: event.goal.id,
                occurredAt: event.occurredAt
              })
            } satisfies AppendManyDecision
          }
          if (compactTransaction !== undefined) {
            const denormalizedMismatch = decoded.some((event) => {
              const row = rowsByEventId.get(event.eventId) ??
                rowsByGoalTime.get(JSON.stringify([event.goal.id, event.occurredAt]))
              return row === undefined ||
                row.eventId !== event.eventId ||
                row.goalId !== event.goal.id ||
                row.occurredAt !== event.occurredAt
            })
            if (denormalizedMismatch) {
              this.#database.exec("ROLLBACK")
              inTransaction = false
              return {
                _tag: "rejected",
                error: new WorkTransactionConflictError({ transactionId: transaction })
              } satisfies AppendManyDecision
            }
          }
          if (legacyCompactTransaction !== undefined) {
            const denormalizedMismatch = legacyCompactTransaction.events.some((identity, index) => {
              const event = decoded[index]
              const row = rowsByEventId.get(identity.eventId)
              return row === undefined ||
                event === undefined ||
                row.goalId !== event.goal.id ||
                row.occurredAt !== event.occurredAt
            })
            if (denormalizedMismatch) {
              this.#database.exec("ROLLBACK")
              inTransaction = false
              return {
                _tag: "rejected",
                error: new WorkTransactionConflictError({ transactionId: transaction })
              } satisfies AppendManyDecision
            }
          }
          const corruptedRow = decodedRows.find(({ event, row }) =>
            row.eventId !== event.eventId || row.goalId !== event.goal.id || row.occurredAt !== event.occurredAt
          )
          if (corruptedRow !== undefined) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkTransactionConflictError({ transactionId: transaction })
            } satisfies AppendManyDecision
          }
          if (unsupportedCompactTransaction) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkTransactionConflictError({ transactionId: transaction })
            } satisfies AppendManyDecision
          }
          if (legacyTransaction !== undefined && !Equal.equals(legacyTransaction, decoded)) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkTransactionConflictError({ transactionId: transaction })
            } satisfies AppendManyDecision
          }
          const newEvents = decoded.filter((_, index) => existing[index] === undefined)
          if (
            compactTransaction !== undefined &&
            newEvents.length !== 0
          ) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkTransactionConflictError({ transactionId: transaction })
            } satisfies AppendManyDecision
          }
          if (newEvents.length !== 0 && existing.some((candidate) => candidate !== undefined)) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            const event = decoded.find((candidate, index) => existing[index] !== undefined)
            if (event === undefined) {
              return {
                _tag: "rejected",
                error: new WorkStoreError({
                  cause: decoded,
                  operation: "appendMany.partial-replay-candidate"
                })
              } satisfies AppendManyDecision
            }
            return {
              _tag: "rejected",
              error: new WorkCheckpointConflictError({
                eventId: event.eventId,
                goalId: event.goal.id,
                occurredAt: event.occurredAt
              })
            } satisfies AppendManyDecision
          }
          if (newEvents.length === 0) {
            if (compactTransaction !== undefined) {
              if (compactTransaction.digest !== digest) {
                this.#database.exec("ROLLBACK")
                inTransaction = false
                return {
                  _tag: "rejected",
                  error: new WorkTransactionConflictError({ transactionId: transaction })
                } satisfies AppendManyDecision
              }
              this.#database.exec("ROLLBACK")
              inTransaction = false
              return { _tag: "replayed", events: decoded } satisfies AppendManyDecision
            }
            if (legacyTransaction !== undefined) {
              this.#database.exec("ROLLBACK")
              inTransaction = false
              return { _tag: "replayed", events: decoded } satisfies AppendManyDecision
            }
            const transactionLedgerTotals = readTransactionLedgerTotals(this.#database)
            if (transactionLedgerTotals.transactionCount >= workTransactionMaxRecords) {
              this.#database.exec("ROLLBACK")
              inTransaction = false
              return {
                _tag: "rejected",
                error: new WorkProjectionError({
                  cause: decoded,
                  detail: `work transaction history cannot exceed ${workTransactionMaxRecords} transaction IDs`,
                  reason: "capacity_exceeded"
                })
              } satisfies AppendManyDecision
            }
            if (transactionLedgerTotals.transactionBytes + transactionEntryBytes > workTransactionMaxBytes) {
              this.#database.exec("ROLLBACK")
              inTransaction = false
              return {
                _tag: "rejected",
                error: new WorkProjectionError({
                  cause: decoded,
                  detail: `work transaction history cannot exceed ${workTransactionMaxBytes} encoded bytes`,
                  reason: "capacity_exceeded"
                })
              } satisfies AppendManyDecision
            }
            this.#database.prepare(
              "INSERT INTO work_goal_transactions (transaction_id, record) VALUES (?, ?)"
            ).run(
              transaction,
              transactionRecord
            )
            this.#database.exec("COMMIT")
            inTransaction = false
            return { _tag: "replayed", events: decoded } satisfies AppendManyDecision
          }
          const eventCount = Schema.decodeUnknownSync(CountRow)(
            this.#database.prepare("SELECT COUNT(*) AS count FROM work_goal_events").get()
          ).count
          if (eventCount + newEvents.length > workHistoryMaxEvents) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkProjectionError({
                cause: decoded,
                detail: `work history cannot exceed ${workHistoryMaxEvents} checkpoints`,
                reason: "capacity_exceeded"
              })
            } satisfies AppendManyDecision
          }
          const history = decodedRows.map(({ event }) => event)
          const prospective = [...history, ...newEvents].toSorted((left, right) =>
            left.occurredAt - right.occurredAt || left.eventId.localeCompare(right.eventId)
          )
          const familyError = validateGoalFamilyHistory(prospective)
          if (familyError !== undefined) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return { _tag: "rejected", error: familyError } satisfies AppendManyDecision
          }
          if (workMaximumSnapshotBytesForHistory(prospective) > fleetResponseBodyMaxBytes) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkProjectionError({
                cause: decoded,
                detail: `work snapshots cannot exceed ${fleetResponseBodyMaxBytes} encoded bytes`,
                reason: "capacity_exceeded"
              })
            } satisfies AppendManyDecision
          }
          const goalIds = new Set(history.map(({ goal }) => goal.id))
          for (const event of newEvents) goalIds.add(event.goal.id)
          if (goalIds.size > workSnapshotMaxGoals) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkProjectionError({
                cause: decoded,
                detail: `work snapshots cannot exceed ${workSnapshotMaxGoals} goals`,
                reason: "capacity_exceeded"
              })
            } satisfies AppendManyDecision
          }
          const creationTimes = new Map<string, number>()
          for (const event of prospective) {
            const creationTime = creationTimes.get(event.goal.id)
            if (creationTime === undefined) {
              if (event.occurredAt !== event.goal.createdAt) {
                this.#database.exec("ROLLBACK")
                inTransaction = false
                return {
                  _tag: "rejected",
                  error: new WorkProjectionError({
                    cause: event,
                    detail: `goal ${event.goal.id} must begin at its creation timestamp`,
                    reason: "inconsistent_history"
                  })
                } satisfies AppendManyDecision
              }
              creationTimes.set(event.goal.id, event.goal.createdAt)
            } else if (creationTime !== event.goal.createdAt) {
              this.#database.exec("ROLLBACK")
              inTransaction = false
              return {
                _tag: "rejected",
                error: new WorkProjectionError({
                  cause: event,
                  detail: `goal ${event.goal.id} changed its creation timestamp`,
                  reason: "inconsistent_history"
                })
              } satisfies AppendManyDecision
            }
          }
          const transactionLedgerTotals = readTransactionLedgerTotals(this.#database)
          if (transactionLedgerTotals.transactionCount >= workTransactionMaxRecords) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkProjectionError({
                cause: decoded,
                detail: `work transaction history cannot exceed ${workTransactionMaxRecords} transaction IDs`,
                reason: "capacity_exceeded"
              })
            } satisfies AppendManyDecision
          }
          if (transactionLedgerTotals.transactionBytes + transactionEntryBytes > workTransactionMaxBytes) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkProjectionError({
                cause: decoded,
                detail: `work transaction history cannot exceed ${workTransactionMaxBytes} encoded bytes`,
                reason: "capacity_exceeded"
              })
            } satisfies AppendManyDecision
          }
          const insert = this.#database.prepare(
            `INSERT INTO work_goal_events
              (event_id, goal_id, occurred_at, record, transaction_id)
             VALUES (?, ?, ?, ?, ?)`
          )
          for (const event of newEvents) {
            insert.run(event.eventId, event.goal.id, event.occurredAt, JSON.stringify(event), transaction)
          }
          this.#database.prepare(
            "INSERT INTO work_goal_transactions (transaction_id, record) VALUES (?, ?)"
          ).run(transaction, transactionRecord)
          this.#database.exec("COMMIT")
          inTransaction = false
          return { _tag: "inserted", events: decoded } satisfies AppendManyDecision
        } catch (error) {
          if (inTransaction) this.#database.exec("ROLLBACK")
          throw error
        }
      },
      catch: storeError("appendMany.insert")
    })
    if (decision._tag === "rejected") return yield* decision.error
    return decision.events
  })

  readonly claim = Effect.fn("WorkStore.claim")(function*(
    this: WorkStore,
    claim: WorkLaneClaim
  ) {
    const decoded = yield* Schema.decodeUnknownEffect(WorkLaneClaim)(claim).pipe(
      Effect.mapError(storeError("claim.decode"))
    )
    yield* this.secureFiles()
    const decision = yield* Effect.try({
      try: () => {
        let inTransaction = false
        try {
          this.#database.exec("BEGIN IMMEDIATE")
          inTransaction = true
          const operationRaw = this.#database.prepare(
            `SELECT lane_id AS laneId, goal_id AS goalId, operation_id AS operationId,
               phase, revision, record
             FROM work_lane_operations WHERE operation_id = ?`
          ).get(decoded.operationId)
          if (operationRaw !== undefined) {
            const prior = Schema.decodeUnknownSync(LaneRow)(operationRaw)
            const priorClaim = Schema.decodeUnknownSync(WorkLaneClaimed)(JSON.parse(prior.record))
            if (
              priorClaim.goalId !== prior.goalId ||
              priorClaim.laneId !== prior.laneId ||
              priorClaim.operationId !== prior.operationId ||
              priorClaim.phase !== prior.phase ||
              priorClaim.revision !== prior.revision
            ) {
              this.#database.exec("ROLLBACK")
              inTransaction = false
              return {
                _tag: "rejected",
                error: new WorkStoreError({
                  cause: { claim: priorClaim, row: prior },
                  operation: "claim.operation.identity-mismatch"
                })
              } satisfies ClaimDecision
            }
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return Equal.equals(claimInputFromClaimed(priorClaim), decoded)
              ? { _tag: "claimed", value: priorClaim } satisfies ClaimDecision
              : {
                _tag: "operation-conflict",
                error: new WorkLaneOperationConflictError({ operationId: decoded.operationId })
              } satisfies ClaimDecision
          }

          const laneLedger = readValidatedLaneLedger(this.#database, "claim.write")
          if (laneLedger._tag === "invalid") {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: laneLedger.error
            } satisfies ClaimDecision
          }
          const existingEntry = laneLedger.entries.find(({ claim }) => claim.laneId === decoded.laneId)
          const existing = existingEntry?.row
          const existingClaim = existingEntry?.claim
          const actualRevision = existingClaim?.revision ?? 0
          if (actualRevision !== decoded.expectedRevision) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "conflict",
              error: new WorkLaneClaimConflictError({
                actualRevision,
                expectedRevision: decoded.expectedRevision,
                laneId: decoded.laneId
              })
            } satisfies ClaimDecision
          }
          if (existingClaim !== undefined && existingClaim.goalId !== decoded.goalId) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "goal-conflict",
              error: new WorkLaneGoalConflictError({
                activeLaneId: existingClaim.laneId,
                goalId: decoded.goalId,
                laneId: decoded.laneId
              })
            } satisfies ClaimDecision
          }
          const activeGoal = laneLedger.entries.find(({ claim }) =>
            claim.goalId === decoded.goalId && claim.phase !== "shipped" && claim.laneId !== decoded.laneId
          )
          if (decoded.phase !== "shipped" && activeGoal !== undefined) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "goal-conflict",
              error: new WorkLaneGoalConflictError({
                activeLaneId: activeGoal.claim.laneId,
                goalId: decoded.goalId,
                laneId: decoded.laneId
              })
            } satisfies ClaimDecision
          }
          if (actualRevision >= Number.MAX_SAFE_INTEGER) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkProjectionError({
                cause: decoded,
                detail: "work lane claim revision cannot exceed Number.MAX_SAFE_INTEGER",
                reason: "capacity_exceeded"
              })
            } satisfies ClaimDecision
          }
          const revision = actualRevision + 1
          const result: WorkLaneClaimed = { ...decoded, revision }
          const encodedRecord = JSON.stringify(result)
          const operationEntryBytes = utf8.encode(decoded.operationId).byteLength +
            utf8.encode(encodedRecord).byteLength
          const operationTotals = readLaneOperationLedgerTotals(this.#database)
          if (operationTotals.operationCount >= workLaneOperationMaxRecords) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkProjectionError({
                cause: decoded,
                detail: `work lane operation history cannot exceed ${workLaneOperationMaxRecords} operation IDs`,
                reason: "capacity_exceeded"
              })
            } satisfies ClaimDecision
          }
          if (operationTotals.operationBytes + operationEntryBytes > workLaneOperationMaxBytes) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkProjectionError({
                cause: decoded,
                detail: `work lane operation history cannot exceed ${workLaneOperationMaxBytes} encoded bytes`,
                reason: "capacity_exceeded"
              })
            } satisfies ClaimDecision
          }
          const entryBytes = utf8.encode(decoded.laneId).byteLength + utf8.encode(encodedRecord).byteLength
          const existingEntryBytes = existing === undefined
            ? 0
            : utf8.encode(decoded.laneId).byteLength + utf8.encode(existing.record).byteLength
          const claimCount = laneLedger.entries.length
          if (existing === undefined && claimCount >= workLaneMaxRecords) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkProjectionError({
                cause: decoded,
                detail: `work lane claims cannot exceed ${workLaneMaxRecords} lanes`,
                reason: "capacity_exceeded"
              })
            } satisfies ClaimDecision
          }
          const claimBytes = Schema.decodeUnknownSync(LedgerBytesRow)(
            this.#database.prepare(
              `SELECT COALESCE(SUM(length(CAST(lane_id AS BLOB)) + length(CAST(record AS BLOB))), 0) AS bytes
               FROM work_lane_claims`
            ).get()
          ).bytes
          if (claimBytes - existingEntryBytes + entryBytes > workLaneMaxBytes) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkProjectionError({
                cause: decoded,
                detail: `work lane claims cannot exceed ${workLaneMaxBytes} encoded bytes`,
                reason: "capacity_exceeded"
              })
            } satisfies ClaimDecision
          }
          const changes = existing === undefined
            ? this.#database.prepare(
              `INSERT INTO work_lane_claims
                 (lane_id, goal_id, operation_id, phase, revision, record)
               VALUES (?, ?, ?, ?, ?, ?)`
            ).run(
              decoded.laneId,
              decoded.goalId,
              decoded.operationId,
              decoded.phase,
              revision,
              encodedRecord
            ).changes
            : this.#database.prepare(
              `UPDATE work_lane_claims
               SET goal_id = ?, operation_id = ?, phase = ?, revision = ?, record = ?
               WHERE lane_id = ? AND revision = ?`
            ).run(
              decoded.goalId,
              decoded.operationId,
              decoded.phase,
              revision,
              encodedRecord,
              decoded.laneId,
              decoded.expectedRevision
            ).changes
          if (changes !== 1 && changes !== 1n) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "conflict",
              error: new WorkLaneClaimConflictError({
                actualRevision,
                expectedRevision: decoded.expectedRevision,
                laneId: decoded.laneId
              })
            } satisfies ClaimDecision
          }
          const operationChanges = this.#database.prepare(
            `INSERT INTO work_lane_operations
               (operation_id, lane_id, goal_id, phase, revision, record)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(
            decoded.operationId,
            decoded.laneId,
            decoded.goalId,
            decoded.phase,
            revision,
            encodedRecord
          ).changes
          if (operationChanges !== 1 && operationChanges !== 1n) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkStoreError({ cause: decoded, operation: "claim.operation.insert" })
            } satisfies ClaimDecision
          }
          this.#database.exec("COMMIT")
          inTransaction = false
          return { _tag: "claimed", value: result } satisfies ClaimDecision
        } catch (error) {
          if (inTransaction) this.#database.exec("ROLLBACK")
          throw error
        }
      },
      catch: storeError("claim.write")
    })
    if (decision._tag !== "claimed") return yield* decision.error
    return decision.value
  })

  readonly decision = Effect.fn("WorkStore.decision")(function*(
    this: WorkStore,
    handoff: WorkDecisionHandoff
  ) {
    const decoded = yield* Schema.decodeUnknownEffect(WorkDecisionHandoff)(handoff).pipe(
      Effect.mapError(storeError("decision.decode"))
    )
    yield* this.secureFiles()
    const encodedHandoff = JSON.stringify(decoded)
    const handoffEntryBytes = utf8.encode(decoded.id).byteLength + utf8.encode(encodedHandoff).byteLength
    const result = yield* Effect.try({
      try: () => {
        let inTransaction = false
        try {
          this.#database.exec("BEGIN IMMEDIATE")
          inTransaction = true
          const sessionRaw = this.#database.prepare(
            `SELECT handoff_id AS handoffId, session_id AS sessionId, lane_id AS laneId,
               occurred_at AS occurredAt, record
             FROM work_decision_handoffs WHERE session_id = ?`
          ).get(decoded.sessionId)
          if (sessionRaw !== undefined) {
            const previous = Schema.decodeUnknownSync(DecisionRow)(sessionRaw)
            const prior = Schema.decodeUnknownSync(WorkDecisionHandoff)(JSON.parse(previous.record))
            this.#database.exec("ROLLBACK")
            inTransaction = false
            if (
              previous.handoffId !== prior.id ||
              previous.sessionId !== prior.sessionId ||
              previous.laneId !== prior.laneId ||
              previous.occurredAt !== prior.occurredAt
            ) {
              return {
                _tag: "rejected",
                error: new WorkStoreError({
                  cause: { row: previous, record: prior },
                  operation: "decision.decode.identity-mismatch"
                })
              } satisfies HandoffDecision
            }
            if (Equal.equals(prior, decoded)) return { _tag: "replayed", value: decoded } satisfies HandoffDecision
            return {
              _tag: "coordinator-conflict",
              error: new WorkCoordinatorHandoffConflictError({ sessionId: decoded.sessionId })
            } satisfies HandoffDecision
          }
          const handoffRaw = this.#database.prepare(
            `SELECT handoff_id AS handoffId, session_id AS sessionId, lane_id AS laneId,
               occurred_at AS occurredAt, record
             FROM work_decision_handoffs WHERE handoff_id = ?`
          ).get(decoded.id)
          if (handoffRaw !== undefined) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "conflict",
              error: new WorkDecisionHandoffConflictError({ handoffId: decoded.id })
            } satisfies HandoffDecision
          }
          const laneLedger = readValidatedLaneLedger(this.#database, "decision.claim")
          if (laneLedger._tag === "invalid") {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return { _tag: "rejected", error: laneLedger.error } satisfies HandoffDecision
          }
          const activeGoalClaims = laneLedger.entries.filter(({ claim }) =>
            claim.goalId === decoded.goalId && claim.phase !== "shipped"
          )
          if (activeGoalClaims.length !== 1 || activeGoalClaims[0]?.claim.laneId !== decoded.laneId) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkDecisionAuthorityConflictError({ goalId: decoded.goalId, laneId: decoded.laneId })
            } satisfies HandoffDecision
          }
          const activeClaim = activeGoalClaims[0].claim
          if (activeClaim.revision !== decoded.expectedRevision) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkDecisionRevisionConflictError({
                actualRevision: activeClaim.revision,
                expectedRevision: decoded.expectedRevision,
                laneId: decoded.laneId
              })
            } satisfies HandoffDecision
          }
          const decisionLedgerTotals = readDecisionLedgerTotals(this.#database)
          if (decisionLedgerTotals.decisionCount >= workDecisionMaxRecords) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkProjectionError({
                cause: decoded,
                detail: `work decision history cannot exceed ${workDecisionMaxRecords} handoffs`,
                reason: "capacity_exceeded"
              })
            } satisfies HandoffDecision
          }
          if (decisionLedgerTotals.decisionBytes + handoffEntryBytes > workDecisionMaxBytes) {
            this.#database.exec("ROLLBACK")
            inTransaction = false
            return {
              _tag: "rejected",
              error: new WorkProjectionError({
                cause: decoded,
                detail: `work decision history cannot exceed ${workDecisionMaxBytes} encoded bytes`,
                reason: "capacity_exceeded"
              })
            } satisfies HandoffDecision
          }
          this.#database.prepare(
            `INSERT INTO work_decision_handoffs
               (handoff_id, session_id, lane_id, occurred_at, record)
             VALUES (?, ?, ?, ?, ?)`
          ).run(decoded.id, decoded.sessionId, decoded.laneId, decoded.occurredAt, encodedHandoff)
          this.#database.exec("COMMIT")
          inTransaction = false
          return { _tag: "inserted", value: decoded } satisfies HandoffDecision
        } catch (error) {
          if (inTransaction) this.#database.exec("ROLLBACK")
          throw error
        }
      },
      catch: storeError("decision.write")
    })
    if (result._tag !== "inserted" && result._tag !== "replayed") return yield* result.error
    return result.value
  })

  readonly currentClaim = Effect.fn("WorkStore.currentClaim")(function*(
    this: WorkStore,
    laneId: string
  ) {
    const decodedLaneId = yield* Schema.decodeUnknownEffect(WorkGoalId)(laneId).pipe(
      Effect.mapError(storeError("claim.read.decode-lane-id"))
    )
    const ledger = yield* Effect.sync(() => readValidatedLaneLedger(this.#database, "claim.read"))
    if (ledger._tag === "invalid") return yield* ledger.error
    const entry = ledger.entries.find(({ claim }) => claim.laneId === decodedLaneId)
    return entry === undefined ? Option.none<WorkLaneClaimed>() : Option.some(entry.claim)
  })

  readonly activeGoalClaim = Effect.fn("WorkStore.activeGoalClaim")(function*(
    this: WorkStore,
    goalId: string
  ) {
    const decodedGoalId = yield* Schema.decodeUnknownEffect(WorkGoalId)(goalId).pipe(
      Effect.mapError(storeError("claim.goal.decode-goal-id"))
    )
    const ledger = yield* Effect.sync(() => readValidatedLaneLedger(this.#database, "claim.goal"))
    if (ledger._tag === "invalid") return yield* ledger.error
    const active = ledger.entries.filter(({ claim }) => claim.goalId === decodedGoalId && claim.phase !== "shipped")
    if (active.length === 0) return Option.none<WorkLaneClaimed>()
    if (active.length !== 1) {
      return yield* new WorkStoreError({
        cause: { goalId: decodedGoalId, lanes: active.map(({ claim }) => claim.laneId) },
        operation: "claim.goal.exclusivity-violation"
      })
    }
    const entry = active[0]
    if (entry === undefined) {
      return yield* new WorkStoreError({ cause: decodedGoalId, operation: "claim.goal.missing-row" })
    }
    return Option.some(entry.claim)
  })

  readonly coordinatorHandoff = Effect.fn("WorkStore.coordinatorHandoff")(function*(
    this: WorkStore,
    sessionId: string
  ) {
    const decodedSessionId = yield* Schema.decodeUnknownEffect(WorkCoordinatorSessionId)(sessionId).pipe(
      Effect.mapError(storeError("decision.session.decode-session-id"))
    )
    const raw = yield* Effect.try({
      try: () =>
        this.#database.prepare(
          `SELECT handoff_id AS handoffId, session_id AS sessionId, lane_id AS laneId,
             occurred_at AS occurredAt, record
           FROM work_decision_handoffs WHERE session_id = ?`
        ).get(decodedSessionId),
      catch: storeError("decision.session.read")
    })
    if (raw === undefined) return Option.none<WorkDecisionHandoff>()
    const row = yield* Schema.decodeUnknownEffect(DecisionRow)(raw).pipe(
      Effect.mapError(storeError("decision.session.decode-row"))
    )
    const handoff = yield* Effect.try({
      try: () => JSON.parse(row.record),
      catch: storeError("decision.session.parse")
    }).pipe(
      Effect.flatMap((value) => Schema.decodeUnknownEffect(WorkDecisionHandoff)(value)),
      Effect.mapError(storeError("decision.session.decode"))
    )
    if (
      handoff.id !== row.handoffId ||
      handoff.sessionId !== row.sessionId ||
      handoff.sessionId !== decodedSessionId ||
      handoff.laneId !== row.laneId ||
      handoff.occurredAt !== row.occurredAt
    ) {
      return yield* new WorkStoreError({
        cause: { handoff, row },
        operation: "decision.session.identity-mismatch"
      })
    }
    return Option.some(handoff)
  })

  readonly decisions = Effect.fn("WorkStore.decisions")(function*(this: WorkStore, laneId: string) {
    const decodedLaneId = yield* Schema.decodeUnknownEffect(WorkGoalId)(laneId).pipe(
      Effect.mapError(storeError("decisions.list.decode-lane-id"))
    )
    const rows = yield* Effect.try({
      try: () =>
        this.#database.prepare(
          `SELECT handoff_id AS handoffId, session_id AS sessionId, lane_id AS laneId,
             occurred_at AS occurredAt, record
           FROM work_decision_handoffs
           WHERE lane_id = ? ORDER BY occurred_at ASC, handoff_id ASC`
        ).all(decodedLaneId),
      catch: storeError("decisions.list")
    })
    return yield* Effect.forEach(rows, (row) =>
      Schema.decodeUnknownEffect(DecisionRow)(row).pipe(
        Effect.mapError(storeError("decisions.decode-row")),
        Effect.flatMap((row) =>
          Effect.try({
            try: () => Schema.decodeUnknownSync(WorkDecisionHandoff)(JSON.parse(row.record)),
            catch: storeError("decisions.decode")
          })
            .pipe(
              Effect.flatMap((handoff) =>
                handoff.laneId !== decodedLaneId
                  ? Effect.fail(
                    new WorkStoreError({
                      cause: { requestedLaneId: decodedLaneId, recordLaneId: handoff.laneId },
                      operation: "decisions.decode.lane-mismatch"
                    })
                  )
                  : handoff.laneId !== row.laneId ||
                      handoff.sessionId !== row.sessionId ||
                      handoff.id !== row.handoffId ||
                      handoff.occurredAt !== row.occurredAt
                  ? Effect.fail(
                    new WorkStoreError({
                      cause: {
                        record: handoff,
                        row: {
                          handoffId: row.handoffId,
                          sessionId: row.sessionId,
                          laneId: row.laneId,
                          occurredAt: row.occurredAt
                        }
                      },
                      operation: "decisions.decode.identity-mismatch"
                    })
                  )
                  : Effect.succeed(handoff)
              )
            )
        )
      ))
  })

  readonly list = Effect.fn("WorkStore.list")(function*(this: WorkStore) {
    const rows = yield* Effect.try({
      try: () =>
        this.#database.prepare(
          "SELECT record FROM work_goal_events ORDER BY occurred_at ASC, event_id ASC"
        ).all(),
      catch: storeError("list")
    })
    return yield* Effect.forEach(rows, decodeRow)
  })

  readonly snapshotInput = Effect.fn("WorkStore.snapshotInput")(function*(this: WorkStore) {
    const source = yield* Effect.try({
      try: () => {
        let inTransaction = false
        try {
          this.#database.exec("BEGIN")
          inTransaction = true
          const events = this.#database.prepare(
            `SELECT event_id AS eventId, goal_id AS goalId, occurred_at AS occurredAt, record
             FROM work_goal_events ORDER BY occurred_at ASC, event_id ASC
             LIMIT ?`
          ).all(workHistoryMaxEvents + 1)
          const bindings = this.#database.prepare(
            `SELECT dispatch_request_id AS dispatchRequestId, lane_id AS laneId,
               expected_revision AS expectedRevision, revision, agent_id AS agentId, host, record
             FROM work_agent_bindings ORDER BY dispatch_request_id ASC
             LIMIT ?`
          ).all(workLaneOperationMaxRecords + 1)
          const laneOperations = this.#database.prepare(
            `SELECT operation_id AS operationId, lane_id AS laneId, goal_id AS goalId,
               phase, revision, record
             FROM work_lane_operations ORDER BY operation_id ASC
             LIMIT ?`
          ).all(workLaneOperationMaxRecords + 1)
          this.#database.exec("COMMIT")
          inTransaction = false
          return { bindings, events, laneOperations }
        } catch (cause) {
          if (inTransaction) this.#database.exec("ROLLBACK")
          throw cause
        }
      },
      catch: storeError("snapshot-input.read")
    })
    const eventRows = yield* Schema.decodeUnknownEffect(Schema.Array(AgentBindingGoalEventRow))(source.events).pipe(
      Effect.mapError(storeError("snapshot-input.decode-events"))
    )
    const bindingRows = yield* Schema.decodeUnknownEffect(AgentBindingRows)(source.bindings).pipe(
      Effect.mapError(storeError("snapshot-input.decode-bindings"))
    )
    const laneRows = yield* Schema.decodeUnknownEffect(Schema.Array(AgentBindingLaneOperationRow))(
      source.laneOperations
    ).pipe(Effect.mapError(storeError("snapshot-input.decode-lane-operations")))
    if (
      eventRows.length > workHistoryMaxEvents ||
      bindingRows.length > workLaneOperationMaxRecords ||
      laneRows.length > workLaneOperationMaxRecords
    ) {
      return yield* new WorkStoreError({ cause: source, operation: "snapshot-input.capacity" })
    }
    const events = yield* Effect.forEach(eventRows, (row) => {
      const decision = decodeAgentBindingGoalEvent(row, "snapshot-input.event")
      return decision._tag === "valid" ? Effect.succeed(decision.checkpoint) : Effect.fail(decision.error)
    })
    const eventById = new Map(eventRows.map((row) => [row.eventId, row]))
    const laneByOperation = new Map(laneRows.map((row) => [row.operationId, row]))
    let logicalObservedAt: number | null = null
    for (const row of bindingRows) {
      const binding = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(WorkAgentBinding)(JSON.parse(row.record)),
        catch: storeError("snapshot-input.decode-binding")
      })
      if (
        row.dispatchRequestId !== binding.request.dispatchRequestId ||
        row.laneId !== binding.request.laneId ||
        row.expectedRevision !== binding.request.expectedRevision ||
        row.revision !== binding.lane.revision ||
        row.agentId !== binding.request.worker.agentId ||
        row.host.toLowerCase() !== binding.request.worker.host.toLowerCase()
      ) {
        return yield* new WorkStoreError({
          cause: { binding, row },
          operation: "snapshot-input.binding-identity-mismatch"
        })
      }
      const readbackError = agentBindingReadbackError(
        binding,
        laneByOperation.get(binding.lane.operationId),
        eventById.get(binding.checkpoint.eventId),
        "snapshot-input.binding"
      )
      if (readbackError !== undefined) return yield* readbackError
      logicalObservedAt = Math.max(logicalObservedAt ?? 0, binding.checkpoint.occurredAt)
    }
    return { events, logicalObservedAt }
  })

  private secureFiles() {
    const files = [this.path, `${this.path}-wal`, `${this.path}-shm`]
    return Effect.forEach(
      files,
      (path) =>
        verifyPathIdentity(path, this.#fileSystem, this.#paths, "secure.path-identity").pipe(
          Effect.andThen(this.#fileSystem.exists(path).pipe(Effect.mapError(storeError("secure.exists")))),
          Effect.flatMap((exists) =>
            exists
              ? this.#fileSystem.chmod(path, 0o600).pipe(Effect.mapError(storeError("secure.chmod")))
              : Effect.void
          )
        ),
      { discard: true }
    )
  }

  close(): void {
    this.#database.close()
  }
}
