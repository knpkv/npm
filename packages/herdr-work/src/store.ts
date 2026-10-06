import { agentConnectTarget, fleetResponseBodyMaxBytes, workReassignActivitySummary } from "@knpkv/herdr-fleet"
import { openPrivateSqlite, type PrivateDatabaseError, type PrivateSqlite } from "@knpkv/herdr-fleet/sqlite"
import { Clock, Crypto, Effect, Equal, Option, Schema } from "effect"
import { Hex } from "effect/encoding"
import type { DatabaseSync, SQLOutputValue } from "node:sqlite"
import { makeWorkAgentBinding } from "./agent-binding.js"
import {
  WorkAdmissionConflictError,
  WorkAgentBindingAuthorityError,
  WorkAgentBindingConflictError,
  WorkCheckpointConflictError,
  WorkCoordinatorHandoffConflictError,
  WorkDecisionAuthorityConflictError,
  WorkDecisionHandoffConflictError,
  WorkDecisionRevisionConflictError,
  WorkGoalAgentTargetConflictError,
  WorkGoalBindingRequiresAgentError,
  WorkGoalOwnerMismatchError,
  WorkGoalReassignmentConflictError,
  WorkGoalRevisionConflictError,
  WorkLaneClaimConflictError,
  WorkLaneGoalConflictError,
  WorkLaneOperationConflictError,
  WorkProjectionError,
  WorkPullRequestLinkError,
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
  decodeAgentBindingRow,
  laneOperationReadbackError
} from "./internal/agent-binding-readback.js"
import {
  CoordinatorCommandRow,
  CoordinatorLifecycleDispatchRow,
  CoordinatorLifecycleEventRow,
  coordinatorLifecycleRunningAt,
  CoordinatorRouteDiscriminatorRow,
  coordinatorRouteRequiresWorkLink,
  type CoordinatorRouteStorageAuthority,
  requireCoordinatorFailedLunaAuthority,
  requireCoordinatorLifecycleAuthority,
  requireCoordinatorRouteAuthority,
  requireCoordinatorRouteBinding
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
import { workHistoryError } from "./internal/history-validation.js"
import {
  LaneOperationLedgerRow,
  LaneOperationTotalsRow,
  planLegacyLaneOperations,
  resolveLegacyLaneClaim
} from "./internal/legacy-lane-claim.js"
import {
  WorkAdmissionTarget,
  WorkAgentBinding,
  WorkAgentBindingRequest,
  WorkCoordinatorSessionId,
  WorkDecisionHandoff,
  WorkDispatchHandoff,
  WorkExistingGoalRecovery,
  WorkGoal,
  WorkGoalCheckpoint,
  WorkGoalId,
  WorkGoalReassigned,
  WorkGoalReassignment,
  workHistoryMaxEvents,
  WorkLaneClaim,
  WorkLaneClaimed,
  WorkObservationEnvelope,
  workObservationMaxSkewMillis,
  WorkObservationSubject,
  WorkObservedFact,
  workObservedFactMaxBytes,
  workObservedFactMaxRecords,
  WorkObservedFailure,
  WorkProspectiveAdmission,
  WorkPullRequestLink,
  WorkRecoveryTarget,
  workSnapshotMaxGoals
} from "./model.js"
import type {
  WorkAdmissionPreflight as WorkAdmissionPreflightType,
  WorkAdmissionTarget as WorkAdmissionTargetType,
  WorkAgentBinding as WorkAgentBindingType,
  WorkAgentBindingRequest as WorkAgentBindingRequestType,
  WorkAgentObservation as WorkAgentObservationType,
  WorkDecisionHandoff as WorkDecisionHandoffType,
  WorkExistingGoalRecovery as WorkExistingGoalRecoveryType,
  WorkGoalCheckpoint as WorkGoalCheckpointType,
  WorkGoalReassigned as WorkGoalReassignedType,
  WorkGoalReassignment as WorkGoalReassignmentType,
  WorkObservationEnvelope as WorkObservationEnvelopeType,
  WorkObservedFact as WorkObservedFactType,
  WorkObservedFailure as WorkObservedFailureType,
  WorkObserveOutcome,
  WorkObserveReport,
  WorkProspectiveAdmission as WorkProspectiveAdmissionType,
  WorkPullRequestLink as WorkPullRequestLinkType,
  WorkPullRequestObservation as WorkPullRequestObservationType,
  WorkRecoveryPreflight as WorkRecoveryPreflightType,
  WorkRecoveryTarget as WorkRecoveryTargetType
} from "./model.js"
import { asciiLower, canonicalSubject, observationSubject } from "./observed.js"

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
const MetadataHandoffIdentityRow = Schema.Struct({
  dispatchRequestId: Schema.String,
  hasWorkLink: Schema.Literals([0, 1]),
  handoffId: Schema.NullOr(Schema.String),
  route: Schema.NullOr(Schema.String)
})
const RoutedMetadataCardinalityRow = Schema.Struct({
  dispatchRequestId: Schema.String,
  metadataCount: Schema.Number
})
const CoordinatorMetadataRouteRow = Schema.Struct({
  activityIdempotencyKey: Schema.NullOr(Schema.String),
  command: Schema.NullOr(Schema.String),
  dispatchRequestId: Schema.String,
  hasWorkLink: Schema.Literals([0, 1]),
  isRouted: Schema.NullOr(Schema.Literals([0, 1])),
  route: Schema.NullOr(Schema.String),
  rowId: Schema.String
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

const fromPrivateDatabaseError = (error: PrivateDatabaseError) =>
  new WorkStoreError({ cause: error.cause, operation: error.operation })

/**
 * Upgrades pre-session Work tables in place. Runs inside `WorkStore.open`'s
 * schema transaction, so a failure here or in a later schema step leaves the
 * file as it was.
 */
const migrateLegacyAuthorityTables = (database: DatabaseSync): void => {
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
    const currentLaneRows = Schema.decodeUnknownSync(Schema.Array(LaneRow))(
      database.prepare(
        `SELECT lane_id AS laneId, goal_id AS goalId, operation_id AS operationId,
           phase, revision, record
         FROM work_lane_claims WHERE lane_id = ? LIMIT 2`
      ).all(decoded.binding.lane.laneId)
    )
    const currentLaneRow = currentLaneRows[0]
    if (currentLaneRows.length !== 1 || currentLaneRow === undefined) {
      throw new WorkStoreError({
        cause: { binding: decoded.binding, currentLaneRows },
        operation: `${operation}.lane-revision`
      })
    }
    let currentLane: typeof WorkLaneClaimed.Type
    try {
      currentLane = Schema.decodeUnknownSync(WorkLaneClaimed)(JSON.parse(currentLaneRow.record))
    } catch (cause) {
      throw new WorkStoreError({ cause, operation: `${operation}.lane-revision` })
    }
    const currentLaneSchema = laneColumns.includes("goal_id")
    const currentOperationRows = currentLaneSchema
      ? Schema.decodeUnknownSync(Schema.Array(AgentBindingLaneOperationRow))(
        database.prepare(
          `SELECT operation_id AS operationId, lane_id AS laneId, goal_id AS goalId,
             phase, revision, record
           FROM work_lane_operations WHERE operation_id = ? LIMIT 2`
        ).all(currentLane.operationId)
      )
      : []
    const currentOperationError = currentLaneSchema
      ? laneOperationReadbackError(
        currentLane,
        currentOperationRows.length === 1 ? currentOperationRows[0] : undefined,
        `${operation}.lane-revision`
      )
      : undefined
    if (
      currentLane.laneId !== currentLaneRow.laneId ||
      currentLane.goalId !== currentLaneRow.goalId ||
      currentLane.operationId !== currentLaneRow.operationId ||
      currentLane.phase !== currentLaneRow.phase ||
      currentLane.revision !== currentLaneRow.revision ||
      currentLane.laneId !== decoded.binding.lane.laneId ||
      currentLane.goalId !== decoded.binding.lane.goalId ||
      currentLane.revision < decoded.binding.lane.revision ||
      (currentLaneSchema && currentLane.revision === decoded.binding.lane.revision &&
        !Equal.equals(currentLane, decoded.binding.lane)) ||
      currentOperationError !== undefined
    ) {
      throw new WorkStoreError({
        cause: { binding: decoded.binding, currentLane, currentLaneRow, currentOperationError },
        operation: `${operation}.lane-revision`
      })
    }
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
  if (tables.includes("orchestrator_dispatch_metadata")) {
    const linkedMetadata = Schema.decodeUnknownSync(Schema.Array(MetadataHandoffIdentityRow))(
      database.prepare(
        `SELECT dispatch_request_id AS dispatchRequestId,
           CASE WHEN work_link IS NULL THEN 0 ELSE 1 END AS hasWorkLink,
           CASE WHEN json_valid(work_link) AND json_type(work_link, '$.handoff.id') = 'text'
             THEN json_extract(work_link, '$.handoff.id') END AS handoffId,
           route
         FROM orchestrator_dispatch_metadata AS metadata
         WHERE work_link IS NOT NULL OR EXISTS (
           SELECT 1 FROM orchestrator_dispatch_metadata AS linked
           WHERE linked.dispatch_request_id = metadata.dispatch_request_id
             AND linked.work_link IS NOT NULL
         ) OR (json_valid(route) AND json_extract(route, '$.model') = 'gpt-5.6-sol')
         LIMIT ${workDecisionMaxRecords + 1}`
      ).all()
    )
    if (linkedMetadata.length > workDecisionMaxRecords) {
      throw new WorkStoreError({ cause: linkedMetadata.length, operation: "open.migrate.metadata-capacity" })
    }
    const metadataCounts = new Map<string, number>()
    const dispatchCounts = new Map<string, number>()
    const decisionCounts = new Map<string, number>()
    for (const metadata of linkedMetadata) {
      metadataCounts.set(
        metadata.dispatchRequestId,
        (metadataCounts.get(metadata.dispatchRequestId) ?? 0) + 1
      )
    }
    for (const dispatch of dispatches) {
      const identity = JSON.stringify([dispatch.dispatchRequestId, dispatch.handoffId])
      dispatchCounts.set(identity, (dispatchCounts.get(identity) ?? 0) + 1)
    }
    for (const decision of decisionIdentities) {
      decisionCounts.set(decision.handoffId, (decisionCounts.get(decision.handoffId) ?? 0) + 1)
    }
    const invalidMetadata = linkedMetadata.find((metadata) => {
      if (metadata.route === null) return true
      const requiresWorkLink = coordinatorRouteRequiresWorkLink(
        metadata.route,
        routeStorageAuthority(metadata.dispatchRequestId, "open.migrate.metadata-decision"),
        "open.migrate.metadata-decision"
      )
      if (!requiresWorkLink) return metadata.hasWorkLink === 1
      const dispatchIdentity = JSON.stringify([metadata.dispatchRequestId, metadata.handoffId])
      return (
        metadata.handoffId === null || metadataCounts.get(metadata.dispatchRequestId) !== 1 ||
        dispatchCounts.get(dispatchIdentity) !== 1 || decisionCounts.get(metadata.handoffId) !== 1
      )
    })
    if (invalidMetadata !== undefined) {
      throw new WorkStoreError({
        cause: { decisionIdentities, dispatches, linkedMetadata, metadata: invalidMetadata },
        operation: "open.migrate.metadata-decision"
      })
    }
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
  // Lanes the running bindings of legacy handoffs recorded; see resolveLegacyLaneClaim.
  const bindingLanes: Array<WorkLaneClaimed> = []
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
        const metadataRows = Schema.decodeUnknownSync(Schema.Array(MetadataWorkLinkRow))(
          database.prepare(
            `SELECT dispatch_request_id AS dispatchRequestId, route, work_link AS workLink
           FROM orchestrator_dispatch_metadata WHERE dispatch_request_id = ? LIMIT 2`
          ).all(dispatch.dispatchRequestId)
        )
        const metadata = metadataRows[0]
        if (metadataRows.length !== 1 || metadata === undefined) {
          throw new WorkStoreError({
            cause: { dispatch, metadataRows },
            operation: "open.migrate.legacy-metadata-authority"
          })
        }
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
      if (lane.revision < bindingDecision.binding.lane.revision) {
        throw new WorkStoreError({
          cause: { binding: bindingDecision.binding, lane, legacy },
          operation: "open.migrate.legacy-handoff-lane-revision"
        })
      }
      bindingLanes.push(bindingDecision.binding.lane)
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
  const migratedClaims = lanes.map((lane) => resolveLegacyLaneClaim(lane, bindingLanes))
  if (laneColumns.length > 0 && !laneColumns.includes("goal_id")) {
    database.exec("ALTER TABLE work_lane_claims ADD COLUMN goal_id TEXT")
    database.exec("ALTER TABLE work_lane_claims ADD COLUMN operation_id TEXT")
    database.exec("ALTER TABLE work_lane_claims ADD COLUMN phase TEXT")
    const update = database.prepare(
      "UPDATE work_lane_claims SET goal_id = ?, operation_id = ?, phase = ?, record = ? WHERE lane_id = ?"
    )
    // An existing lane-operation ledger is not backfilled later, so record each
    // migrated claim's operation here; the claim's readback requires it.
    // Without a ledger, schema creation below creates it and backfills every
    // claim, so the same bound applies to an empty ledger.
    const hasLedger = tables.includes("work_lane_operations")
    const operations = planLegacyLaneOperations(
      migratedClaims.map(({ lane }) => lane),
      new Map(
        hasLedger
          ? migratedClaims.flatMap(({ lane }) => {
            const matches = database.prepare(
              `SELECT operation_id AS operationId, lane_id AS laneId, goal_id AS goalId, phase, revision, record
               FROM work_lane_operations WHERE CAST(operation_id AS TEXT) = ?`
            ).all(lane.operationId)
            const rows = Schema.decodeUnknownSync(Schema.Array(LaneOperationLedgerRow))(matches)
            // A key stored as a blob, or twice, is a collision even when its bytes match.
            const found = rows.find(({ operationId }) => operationId !== lane.operationId) ?? rows[0]
            return found === undefined ? [] : [[lane.operationId, found]]
          })
          : []
      ),
      hasLedger
        ? Schema.decodeUnknownSync(LaneOperationTotalsRow)(
          database.prepare(
            `SELECT COUNT(*) AS count, COALESCE(SUM(
               length(CAST(operation_id AS BLOB)) + length(CAST(record AS BLOB))), 0) AS bytes
             FROM work_lane_operations`
          ).get()
        )
        : { bytes: 0, count: 0 },
      { bytes: workLaneOperationMaxBytes, records: workLaneOperationMaxRecords }
    )
    if (operations._tag === "collision") {
      throw new WorkStoreError({ cause: operations, operation: "open.migrate.lane-operation-collision" })
    }
    if (operations._tag === "capacity") {
      throw new WorkStoreError({ cause: operations, operation: "open.migrate.lane-operation-capacity" })
    }
    for (const { lane } of migratedClaims) {
      update.run(lane.goalId, lane.operationId, lane.phase, JSON.stringify(lane), lane.laneId)
    }
    if (hasLedger && operations.inserts.length > 0) {
      const recordOperation = database.prepare(
        `INSERT INTO work_lane_operations
           (operation_id, lane_id, goal_id, phase, revision, record) VALUES (?, ?, ?, ?, ?, ?)`
      )
      for (const lane of operations.inserts) {
        recordOperation.run(lane.operationId, lane.laneId, lane.goalId, lane.phase, lane.revision, JSON.stringify(lane))
      }
    }
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
      const laneRevision = Schema.decodeUnknownSync(LaneRevisionRow)(
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
      if (laneRevision.revision < bindingDecision.binding.lane.revision) {
        throw new WorkStoreError({
          cause: { binding: bindingDecision.binding, laneRevision, previous },
          operation: "open.migrate.handoff-lane-revision"
        })
      }
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
  // Reported after capacity: lane CAS allows one binding per revision, so
  // several mean the file is inconsistent rather than merely large.
  const ambiguousClaims = migratedClaims.filter(({ _tag }) => _tag === "ambiguous")
  if (ambiguousClaims.length > 0) {
    throw new WorkStoreError({ cause: { claims: ambiguousClaims }, operation: "open.migrate.lane-binding-ambiguous" })
  }
  const mismatchedClaims = migratedClaims.filter(({ _tag }) => _tag === "mismatch")
  if (mismatchedClaims.length > 0) {
    throw new WorkStoreError({ cause: { claims: mismatchedClaims }, operation: "open.migrate.lane-binding-mismatch" })
  }
  if (tables.includes("orchestrator_dispatch_metadata") && coordinatorDispatchColumns.includes("is_routed")) {
    const pageSize = 512
    let cursor: string | null = null
    while (true) {
      const input = cursor === null
        ? database.prepare(
          `SELECT CAST(metadata.rowid AS TEXT) AS rowId,
               metadata.dispatch_request_id AS dispatchRequestId,
               dispatch.activity_idempotency_key AS activityIdempotencyKey,
               dispatch.command, dispatch.is_routed AS isRouted,
               CASE WHEN metadata.work_link IS NULL THEN 0 ELSE 1 END AS hasWorkLink,
               metadata.route
             FROM orchestrator_dispatch_metadata AS metadata
             LEFT JOIN orchestrator_dispatches AS dispatch
               ON dispatch.dispatch_request_id = metadata.dispatch_request_id
             ORDER BY metadata.rowid ASC LIMIT ?`
        ).all(pageSize)
        : database.prepare(
          `SELECT CAST(metadata.rowid AS TEXT) AS rowId,
               metadata.dispatch_request_id AS dispatchRequestId,
               dispatch.activity_idempotency_key AS activityIdempotencyKey,
               dispatch.command, dispatch.is_routed AS isRouted,
               CASE WHEN metadata.work_link IS NULL THEN 0 ELSE 1 END AS hasWorkLink,
               metadata.route
             FROM orchestrator_dispatch_metadata AS metadata
             LEFT JOIN orchestrator_dispatches AS dispatch
               ON dispatch.dispatch_request_id = metadata.dispatch_request_id
             WHERE metadata.rowid > CAST(? AS INTEGER)
             ORDER BY metadata.rowid ASC LIMIT ?`
        ).all(cursor, pageSize)
      const rows = Schema.decodeUnknownSync(Schema.Array(CoordinatorMetadataRouteRow))(input)
      for (const row of rows) {
        try {
          const isLegacyUnroutedOrphan = row.activityIdempotencyKey === null && row.command === null &&
            row.isRouted === null && row.route === null && row.hasWorkLink === 0
          if (isLegacyUnroutedOrphan) continue
          if (
            row.activityIdempotencyKey === null || row.command === null ||
            row.route === null || row.isRouted === null
          ) {
            throw new WorkStoreError({ cause: row, operation: "open.migrate.metadata-route" })
          }
          requireCoordinatorRouteBinding(
            row.command,
            row.activityIdempotencyKey,
            row.route,
            row.hasWorkLink === 1,
            { _tag: "routed_discriminator", isRouted: row.isRouted },
            "open.migrate.metadata-route"
          )
        } catch (cause) {
          if (Schema.is(WorkStoreError)(cause)) throw cause
          throw new WorkStoreError({ cause, operation: "open.migrate.metadata-route" })
        }
      }
      const last = rows.at(-1)
      if (rows.length < pageSize || last === undefined) break
      cursor = last.rowId
    }
    const invalidRoutedMetadata = Schema.decodeUnknownSync(Schema.Array(RoutedMetadataCardinalityRow))(
      database.prepare(
        `SELECT dispatch.dispatch_request_id AS dispatchRequestId,
             COUNT(metadata.dispatch_request_id) AS metadataCount
           FROM orchestrator_dispatches AS dispatch
           LEFT JOIN orchestrator_dispatch_metadata AS metadata
             ON metadata.dispatch_request_id = dispatch.dispatch_request_id
           WHERE dispatch.is_routed = 1
           GROUP BY dispatch.dispatch_request_id
           HAVING COUNT(metadata.dispatch_request_id) <> 1
           LIMIT 1`
      ).all()
    )[0]
    if (invalidRoutedMetadata !== undefined) {
      throw new WorkStoreError({
        cause: invalidRoutedMetadata,
        operation: "open.migrate.routed-metadata"
      })
    }
  }
}

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
  | { readonly _tag: "rejected"; readonly error: WorkProjectionError | WorkStoreError | WorkPullRequestLinkError }
  | { readonly _tag: "claimed"; readonly value: WorkLaneClaimed }

type ReassignRejection =
  | WorkGoalAgentTargetConflictError
  | WorkGoalBindingRequiresAgentError
  | WorkGoalOwnerMismatchError
  | WorkGoalReassignmentConflictError
  | WorkGoalRevisionConflictError
  | WorkProjectionError
  | WorkStoreError
type ReassignDecision =
  | { readonly _tag: "reassigned"; readonly result: WorkGoalReassignedType }
  | { readonly _tag: "rejected"; readonly error: ReassignRejection }
const ReassignmentRow = Schema.Struct({ approvalJobId: Schema.String, goalId: Schema.String, record: Schema.String })

/** Applies a reassignment's agent choice; `keep` is only reached when the goal has no target. */
const withReassignedAgent = <G extends object>(
  goal: G,
  toAgent: WorkGoalReassignmentType["toAgent"]
) => {
  switch (toAgent._tag) {
    case "set":
      return { ...goal, agentHierarchy: { agent: toAgent.agent }, connectTarget: agentConnectTarget(toAgent.agent) }
    case "clear":
      return { ...goal, agentHierarchy: null, connectTarget: null }
    case "keep":
      return goal
  }
}

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

const claimInputFromClaimed = (claim: WorkLaneClaimed): WorkLaneClaim => {
  const input = {
    branch: claim.branch,
    expectedRevision: claim.expectedRevision,
    goalId: claim.goalId,
    head: claim.head,
    laneId: claim.laneId,
    operationId: claim.operationId,
    owner: claim.owner,
    parent: claim.parent,
    phase: claim.phase
  }
  return claim.reconciliation === undefined
    ? { ...input, worktree: claim.worktree }
    : { ...input, reconciliation: claim.reconciliation, worktree: claim.worktree }
}

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

const admissionConflict = (target: WorkAdmissionTargetType, reason: string) =>
  new WorkAdmissionConflictError({ goalId: target.goalId, laneId: target.laneId, reason })

type AdmissionInspection =
  | Exclude<WorkAdmissionPreflightType, { readonly _tag: "prospective" }>
  | { readonly _tag: "prospective"; readonly target: WorkAdmissionTargetType; readonly snapshot: string }

type AdmissionRejection = {
  readonly _tag: "rejected"
  readonly error: WorkAdmissionConflictError
}

/**
 * Splits bindings into each lane's authoritative row (highest lane revision)
 * and the lanes where that revision is shared by more than one row. Earlier
 * rows on a lane were superseded, for example by an approved reassignment.
 */
const authoritativeBindings = (bindings: ReadonlyArray<WorkAgentBindingType>) => {
  const maxRevision = new Map<string, number>()
  for (const binding of bindings) {
    const laneId = binding.request.laneId
    maxRevision.set(laneId, Math.max(maxRevision.get(laneId) ?? 0, binding.lane.revision))
  }
  const latest = bindings.filter((binding) => binding.lane.revision === maxRevision.get(binding.request.laneId))
  const ambiguousLanes = new Set(
    latest
      .map(({ request }) => request.laneId)
      .filter((laneId, index, laneIds) => laneIds.indexOf(laneId) !== index)
  )
  return { latest, ambiguousLanes }
}

/** Reads every durable identity row, including entries omitted by time-window projections. */
const admissionState = (database: DatabaseSync, target: WorkAdmissionTargetType): AdmissionInspection => {
  const eventRows = Schema.decodeUnknownSync(Schema.Array(AgentBindingGoalEventRow))(
    database.prepare(
      `SELECT event_id AS eventId, goal_id AS goalId, occurred_at AS occurredAt, record
       FROM work_goal_events ORDER BY occurred_at ASC, event_id ASC LIMIT ?`
    ).all(workHistoryMaxEvents + 1)
  )
  const lanes = readValidatedLaneLedger(database, "admission.inspect")
  if (lanes._tag === "invalid") throw lanes.error
  const bindingRows = Schema.decodeUnknownSync(AgentBindingRows)(
    database.prepare(
      `SELECT dispatch_request_id AS dispatchRequestId, lane_id AS laneId,
       expected_revision AS expectedRevision, revision, agent_id AS agentId, host, record
       FROM work_agent_bindings ORDER BY dispatch_request_id ASC LIMIT ?`
    ).all(workLaneOperationMaxRecords + 1)
  )
  const operationRows = Schema.decodeUnknownSync(Schema.Array(AgentBindingLaneOperationRow))(
    database.prepare(
      `SELECT operation_id AS operationId, lane_id AS laneId, goal_id AS goalId,
       phase, revision, record FROM work_lane_operations ORDER BY operation_id ASC LIMIT ?`
    ).all(workLaneOperationMaxRecords + 1)
  )
  if (
    eventRows.length > workHistoryMaxEvents || bindingRows.length > workLaneOperationMaxRecords ||
    operationRows.length > workLaneOperationMaxRecords
  ) {
    throw new WorkStoreError({ cause: target, operation: "admission.inspect.capacity" })
  }
  const events = eventRows.map((row) => {
    const decision = decodeAgentBindingGoalEvent(row, "admission.inspect.event")
    if (decision._tag === "invalid") throw decision.error
    return decision.checkpoint
  })
  const historyError = workHistoryError(events)
  if (historyError !== undefined) throw historyError
  const bindings = bindingRows.map((row) => {
    const binding = Schema.decodeUnknownSync(WorkAgentBinding)(JSON.parse(row.record))
    if (
      row.dispatchRequestId !== binding.request.dispatchRequestId ||
      row.laneId !== binding.request.laneId || row.revision !== binding.lane.revision ||
      row.agentId !== binding.request.worker.agentId ||
      row.host.toLowerCase() !== binding.request.worker.host.toLowerCase()
    ) {
      throw new WorkStoreError({ cause: row, operation: "admission.inspect.binding-identity" })
    }
    const readback = agentBindingReadbackError(
      binding,
      operationRows.find(({ operationId }) => operationId === binding.lane.operationId),
      eventRows.find(({ eventId }) => eventId === binding.checkpoint.eventId),
      "admission.inspect.binding"
    )
    if (readback !== undefined) throw readback
    return binding
  })
  const latest = new Map<string, WorkGoalCheckpointType>()
  for (const event of events) latest.set(event.goal.id, event)
  const goal = [...latest.values()].find(({ goal }) => goal.review?.url === target.reviewUrl)
  const lane = lanes.entries.find(({ claim }) => claim.laneId === target.laneId)?.claim
  const authority = authoritativeBindings(bindings)
  const binding = authority.latest.find(({ lane: bound }) => bound.laneId === target.laneId)
  const foreignConflict =
    events.some(({ goal: entry }) =>
      (entry.review?.url === target.reviewUrl && entry.id !== target.goalId) ||
      (entry.agentHierarchy?.agent.agentId === target.worker.agentId && entry.id !== target.goalId) ||
      (entry.goalFamily?.canonicalGoalId === target.goalId && entry.id !== target.goalId)
    ) || lanes.entries.some(({ claim }) =>
      (claim.goalId === target.goalId && claim.laneId !== target.laneId) ||
      (claim.worktree === target.worktree && claim.laneId !== target.laneId)
    ) ||
    authority.latest.some(({ request }) =>
      request.worker.agentId === target.worker.agentId && request.laneId !== target.laneId
    ) ||
    // A session id stays claimed by its lane even after a reassignment supersedes that binding.
    bindings.some(({ request }) =>
      (request.prospectiveAdmission?.sessionId === target.sessionId && request.laneId !== target.laneId) ||
      (request.existingGoalRecovery?.sessionId === target.sessionId && request.laneId !== target.laneId)
    ) || authority.ambiguousLanes.has(target.laneId)
  const exact = goal !== undefined && lane !== undefined && binding !== undefined &&
    goal.goal.id === target.goalId && goal.goal.state !== "completed" &&
    goal.goal.state !== "deployed" && goal.goal.goalFamily?.role === "canonical" &&
    goal.goal.goalFamily.canonicalGoalId === target.goalId &&
    Equal.equals(goal.goal.owner, target.owner) &&
    lane.goalId === target.goalId && lane.head === target.head &&
    lane.worktree === target.worktree && lane.branch === target.branch &&
    lane.phase !== "shipped" && Equal.equals(lane.owner, target.owner) &&
    binding.lane.laneId === target.laneId &&
    Equal.equals(binding.request.worker, target.worker) &&
    (binding.request.prospectiveAdmission === undefined || (
      binding.request.prospectiveAdmission.sessionId === target.sessionId &&
      binding.request.prospectiveAdmission.workAssignment === target.expectedWork &&
      binding.request.prospectiveAdmission.baseHead === target.baseHead
    )) &&
    (binding.request.existingGoalRecovery === undefined ||
      (binding.request.existingGoalRecovery.sessionId === target.sessionId &&
        binding.request.existingGoalRecovery.workAssignment === target.expectedWork &&
        binding.request.existingGoalRecovery.baseHead === target.baseHead))
  if (exact && !foreignConflict) {
    return {
      _tag: "existing",
      target,
      link: Schema.decodeUnknownSync(WorkPullRequestLink)({
        request: {
          repository: target.repository,
          pullRequest: target.pullRequest,
          goalId: target.goalId,
          laneId: target.laneId
        },
        goalEventId: goal.eventId,
        goal: goal.goal,
        lane,
        binding
      })
    }
  }
  const conflicts =
    events.some(({ goal: entry }) =>
      entry.id === target.goalId || entry.review?.url === target.reviewUrl ||
      entry.goalFamily?.canonicalGoalId === target.goalId ||
      entry.agentHierarchy?.agent.agentId === target.worker.agentId
    ) || lanes.entries.some(({ claim }) =>
      claim.laneId === target.laneId || claim.goalId === target.goalId ||
      claim.worktree === target.worktree
    ) || authority.latest.some(({ request }) => request.worker.agentId === target.worker.agentId) ||
    bindings.some(({ request }) =>
      request.prospectiveAdmission?.sessionId === target.sessionId ||
      request.existingGoalRecovery?.sessionId === target.sessionId
    )
  if (conflicts) {
    return { _tag: "conflict", target, reason: "durable PR, goal, lane, worker, or worktree is already bound" }
  }
  const snapshot = JSON.stringify({
    target,
    eventRows,
    lanes: lanes.entries.map(({ row }) => row),
    bindingRows,
    operationRows
  })
  return { _tag: "prospective", target, snapshot }
}

const readAdmissionState = (database: DatabaseSync, target: WorkAdmissionTargetType): AdmissionInspection => {
  database.exec("BEGIN")
  try {
    const state = admissionState(database, target)
    database.exec("ROLLBACK")
    return state
  } catch (cause) {
    database.exec("ROLLBACK")
    throw cause
  }
}

type RecoveryInspection =
  | Exclude<WorkRecoveryPreflightType, { readonly _tag: "recoverable" }>
  | {
    readonly _tag: "recoverable"
    readonly target: WorkRecoveryTargetType
    readonly snapshot: string
    readonly original: WorkGoalCheckpointType
    readonly history: ReadonlyArray<WorkGoalCheckpointType>
  }

const recoveryTables: ReadonlyArray<string> = [
  "work_goal_events",
  "work_lane_claims",
  "work_lane_operations",
  "work_agent_bindings",
  "work_goal_transactions",
  "work_goal_transaction_totals",
  "work_lane_operation_totals",
  "work_decision_handoffs",
  "work_decision_totals"
]

/** Validates every historical operation against its indexed row and current lane. */
const readRecoveryOperations = (database: DatabaseSync) => {
  const lanes = readValidatedLaneLedger(database, "recovery.preflight")
  if (lanes._tag === "invalid") throw lanes.error
  const rows = Schema.decodeUnknownSync(Schema.Array(AgentBindingLaneOperationRow))(
    database
      .prepare(
        `SELECT operation_id AS operationId, lane_id AS laneId, goal_id AS goalId,
       phase, revision, record FROM work_lane_operations ORDER BY operation_id ASC LIMIT ?`
      )
      .all(workLaneOperationMaxRecords + 1)
  )
  if (rows.length > workLaneOperationMaxRecords) {
    throw new WorkStoreError({ cause: rows.length, operation: "recovery.preflight.ledger-capacity" })
  }
  const current = new Map(lanes.entries.map(({ claim, row }) => [claim.laneId, { claim, row }]))
  const revisions = new Set<string>()
  const claims = rows.map((row) => {
    let claim: WorkLaneClaimed
    try {
      claim = Schema.decodeUnknownSync(WorkLaneClaimed)(JSON.parse(row.record))
    } catch (cause) {
      throw new WorkStoreError({ cause, operation: "recovery.preflight.operation-decode" })
    }
    if (
      claim.operationId !== row.operationId || claim.laneId !== row.laneId ||
      claim.goalId !== row.goalId || claim.phase !== row.phase || claim.revision !== row.revision
    ) {
      throw new WorkStoreError({ cause: { claim, row }, operation: "recovery.preflight.operation-identity" })
    }
    const lane = current.get(claim.laneId)
    const key = `${claim.laneId}\u0000${String(claim.revision)}`
    if (
      lane === undefined || lane.claim.goalId !== claim.goalId ||
      claim.revision > lane.claim.revision || revisions.has(key) ||
      (claim.revision === lane.claim.revision && row.record !== lane.row.record)
    ) {
      throw new WorkStoreError({ cause: { claim, row, lane }, operation: "recovery.preflight.operation-companion" })
    }
    revisions.add(key)
    return claim
  })
  const byOperation = new Map(rows.map((row) => [row.operationId, row]))
  if (
    lanes.entries.some(({ claim, row }) => {
      const latest = byOperation.get(claim.operationId)
      return latest === undefined || latest.revision !== claim.revision || latest.record !== row.record
    })
  ) {
    throw new WorkStoreError({ cause: lanes.entries, operation: "recovery.preflight.missing-latest-operation" })
  }
  return { lanes, rows, claims }
}

/** Reads the complete Work authority, including rows outside every projection window. */
const recoveryState = (database: DatabaseSync, target: WorkRecoveryTargetType): RecoveryInspection => {
  const inspected = admissionState(database, target)
  const operations = readRecoveryOperations(database)
  if (inspected._tag === "existing") return { _tag: "existing", target, link: inspected.link }
  const conflict = (reason: string): RecoveryInspection => ({
    _tag: "conflict",
    target,
    reason
  })
  const tables = recoveryTables.map((name) => {
    const rows = database.prepare(`SELECT * FROM ${name} ORDER BY rowid ASC LIMIT ?`).all(workHistoryMaxEvents + 1)
    if (rows.length > workHistoryMaxEvents) {
      throw new WorkStoreError({
        cause: name,
        operation: "recovery.preflight.capacity"
      })
    }
    return { name, rows }
  })
  const eventRows = Schema.decodeUnknownSync(Schema.Array(AgentBindingGoalEventRow))(
    database
      .prepare(
        `SELECT event_id AS eventId, goal_id AS goalId, occurred_at AS occurredAt, record
       FROM work_goal_events ORDER BY occurred_at ASC, event_id ASC LIMIT ?`
      )
      .all(workHistoryMaxEvents + 1)
  )
  if (eventRows.length > workHistoryMaxEvents) {
    throw new WorkStoreError({
      cause: target,
      operation: "recovery.preflight.history-capacity"
    })
  }
  const history = eventRows.map((row) => {
    const decision = decodeAgentBindingGoalEvent(row, "recovery.preflight.event")
    if (decision._tag === "invalid") throw decision.error
    return decision.checkpoint
  })
  const historyError = workHistoryError(history)
  if (historyError !== undefined) throw historyError
  const own = history.filter(({ goal }) => goal.id === target.goalId)
  const original = own.at(-1)
  if (original === undefined) return conflict("canonical goal does not exist")
  if (original.eventId !== target.expectedGoalEventId || original.goal.updatedAt !== target.expectedGoalUpdatedAt) {
    return conflict("approved goal event or revision is stale")
  }
  if (
    own.some(
      ({ goal }) =>
        goal.goalFamily?.role !== "canonical" ||
        goal.goalFamily.canonicalGoalId !== target.goalId ||
        !Equal.equals(goal.owner, target.owner) ||
        (goal.repository.repository !== target.repository &&
          (goal.repository.repository !== target.worktree || goal.repository.branch !== target.branch)) ||
        goal.connectTarget !== null ||
        (goal.agentHierarchy !== undefined && goal.agentHierarchy !== null) ||
        (goal.review?.url !== null && goal.review?.url !== undefined && goal.review.url !== target.reviewUrl) ||
        goal.state === "completed" ||
        goal.state === "deployed"
    )
  ) {
    return conflict("canonical goal history is linked, terminal, or belongs to another owner")
  }
  const bindingRows = Schema.decodeUnknownSync(AgentBindingRows)(
    database
      .prepare(
        `SELECT dispatch_request_id AS dispatchRequestId, lane_id AS laneId,
       expected_revision AS expectedRevision, revision, agent_id AS agentId, host, record
       FROM work_agent_bindings ORDER BY dispatch_request_id ASC LIMIT ?`
      )
      .all(workLaneOperationMaxRecords + 1)
  )
  if (bindingRows.length > workLaneOperationMaxRecords) {
    throw new WorkStoreError({
      cause: target,
      operation: "recovery.preflight.ledger-capacity"
    })
  }
  const bindings = bindingRows.map((row) => Schema.decodeUnknownSync(WorkAgentBinding)(JSON.parse(row.record)))
  const decisions = Schema.decodeUnknownSync(Schema.Array(DecisionRow))(
    database
      .prepare(
        `SELECT handoff_id AS handoffId, session_id AS sessionId, lane_id AS laneId,
       occurred_at AS occurredAt, record FROM work_decision_handoffs ORDER BY handoff_id ASC LIMIT ?`
      )
      .all(workHistoryMaxEvents + 1)
  )
  if (decisions.length > workHistoryMaxEvents) {
    throw new WorkStoreError({
      cause: target,
      operation: "recovery.preflight.decision-capacity"
    })
  }
  if (
    history.some(
      ({ goal }) =>
        goal.id !== target.goalId &&
        (goal.review?.url === target.reviewUrl ||
          goal.goalFamily?.canonicalGoalId === target.goalId ||
          goal.agentHierarchy?.agent.agentId === target.worker.agentId)
    ) ||
    operations.lanes.entries.some(
      ({ claim }) =>
        claim.goalId === target.goalId || claim.laneId === target.laneId || claim.worktree === target.worktree
    ) ||
    operations.claims.some(
      ({ goalId, laneId, worktree }) =>
        goalId === target.goalId || laneId === target.laneId || worktree === target.worktree
    ) ||
    bindings.some(
      ({ request }) =>
        request.laneId === target.laneId ||
        request.worker.agentId === target.worker.agentId ||
        request.prospectiveAdmission?.sessionId === target.sessionId ||
        request.existingGoalRecovery?.sessionId === target.sessionId
    ) ||
    decisions.some(({ record }) => {
      const handoff = Schema.decodeUnknownSync(WorkDecisionHandoff)(JSON.parse(record))
      return (
        handoff.goalId === target.goalId || handoff.laneId === target.laneId || handoff.sessionId === target.sessionId
      )
    })
  ) {
    return conflict("historical PR, goal, lane, worker, session, or worktree linkage conflicts")
  }
  return {
    _tag: "recoverable",
    target,
    original,
    history,
    snapshot: JSON.stringify({ target, tables })
  }
}

const readRecoveryState = (database: DatabaseSync, target: WorkRecoveryTargetType): RecoveryInspection => {
  database.exec("BEGIN")
  try {
    const state = recoveryState(database, target)
    database.exec("ROLLBACK")
    return state
  } catch (cause) {
    database.exec("ROLLBACK")
    throw cause
  }
}

export interface WorkStoreService {
  readonly recoveryPreflight: (
    target: WorkRecoveryTargetType
  ) => Effect.Effect<WorkRecoveryPreflightType, WorkProjectionError | WorkStoreError>
  readonly recoverExistingGoal: (
    request: WorkExistingGoalRecoveryType
  ) => Effect.Effect<WorkPullRequestLinkType, WorkAdmissionConflictError | WorkProjectionError | WorkStoreError>
  /** Moves one goal, and its active lane, from the exact current owner under an approved Fleet job. */
  readonly reassign: (
    request: WorkGoalReassignmentType
  ) => Effect.Effect<WorkGoalReassignedType, ReassignRejection>
  readonly admissionPreflight: (
    target: WorkAdmissionTargetType
  ) => Effect.Effect<WorkAdmissionPreflightType, WorkProjectionError | WorkStoreError>
  readonly admitExistingOwner: (
    request: WorkProspectiveAdmissionType
  ) => Effect.Effect<WorkPullRequestLinkType, WorkAdmissionConflictError | WorkProjectionError | WorkStoreError>
  readonly bindAgent: (
    request: WorkAgentBindingRequestType
  ) => Effect.Effect<
    WorkAgentBindingType,
    WorkAgentBindingAuthorityError | WorkAgentBindingConflictError | WorkProjectionError | WorkStoreError
  >
  readonly agentBinding: (
    dispatchRequestId: string
  ) => Effect.Effect<Option.Option<WorkAgentBindingType>, WorkStoreError>
  readonly bindingDispatchesForLane: (
    laneId: string
  ) => Effect.Effect<ReadonlyArray<string>, WorkStoreError>
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
    | WorkPullRequestLinkError
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
  /**
   * Stores the latest observed facts per subject. Facts are never goal history
   * and never input to an approval token, so observing cannot invalidate a
   * pending approval or fill the goal history.
   */
  readonly observe: (
    envelopes: ReadonlyArray<WorkObservationEnvelopeType>
  ) => Effect.Effect<WorkObserveReport, WorkStoreError>
  /** Atomically reads projection history, observed facts, and the coordinator-owned logical-time boundary. */
  readonly snapshotInput: () => Effect.Effect<{
    readonly events: ReadonlyArray<WorkGoalCheckpointType>
    readonly facts: ReadonlyArray<WorkObservedFactType>
    readonly failures: ReadonlyArray<WorkObservedFailureType>
    readonly logicalObservedAt: number | null
  }, WorkStoreError>
}

const ObservedFactRow = Schema.Struct({
  subject: Schema.String,
  observationId: Schema.String,
  observedAt: Schema.Number,
  confirmedAt: Schema.Number,
  record: Schema.String
})

const StoredFactRow = Schema.Struct({ observationId: Schema.String, confirmedAt: Schema.Number })
const FactTotalsRow = Schema.Struct({ count: Schema.Number, bytes: Schema.Number })
const EvictionRow = Schema.Struct({ subject: Schema.String, bytes: Schema.Number })

type PreparedObservation =
  | {
    readonly _tag: "fact"
    readonly subject: string
    readonly observationId: string
    readonly observedAt: number
    readonly record: string
  }
  | { readonly _tag: "future"; readonly subject: string }
  | {
    readonly _tag: "unknown"
    readonly subject: string
    readonly source: "github" | "herdr" | "git"
    readonly reason: string
    readonly observedAt: number
  }

const canonicalObservation = (
  observation: WorkPullRequestObservationType | WorkAgentObservationType
): WorkPullRequestObservationType | WorkAgentObservationType =>
  observation._tag === "agent"
    ? { ...observation, host: asciiLower(observation.host) }
    : { ...observation, repository: asciiLower(observation.repository) }

/**
 * Applies each observation in one transaction, then evicts the oldest rows
 * until facts and failures are each within their bounds.
 *
 * - The same facts again keep their first-seen time and move `confirmed_at`.
 * - Different facts replace the stored ones, unless the stored ones were
 *   confirmed at or after this observation (then it is stale).
 * - A good read ends the subject's run of failures. A failure starts a run,
 *   or keeps the running one's `since`; one older than the last good read is stale.
 */
const writeObservations = (
  database: DatabaseSync,
  prepared: ReadonlyArray<PreparedObservation>
): WorkObserveReport => {
  database.exec("BEGIN IMMEDIATE")
  try {
    const readFact = database.prepare(
      `SELECT observation_id AS observationId, confirmed_at AS confirmedAt
       FROM work_observed_facts WHERE subject = ?`
    )
    const upsertFact = database.prepare(
      `INSERT INTO work_observed_facts (subject, observation_id, observed_at, confirmed_at, record)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (subject) DO UPDATE SET observation_id = excluded.observation_id,
         observed_at = excluded.observed_at, confirmed_at = excluded.confirmed_at, record = excluded.record`
    )
    const confirmFact = database.prepare(
      "UPDATE work_observed_facts SET confirmed_at = max(confirmed_at, ?) WHERE subject = ?"
    )
    // A good read ends a run of failures only if it is newer than the run's
    // latest failure.
    const clearFailures = database.prepare("DELETE FROM work_observed_failures WHERE subject = ? AND last_at <= ?")
    // We keep only the run's first and latest failure, so a run split by a
    // delayed good read restarts at its latest failure: a real failed read.
    const trimFailures = database.prepare(
      "UPDATE work_observed_failures SET since = last_at WHERE subject = ? AND since <= ? AND last_at > ?"
    )
    const endFailures = {
      run: (subject: string, observedAt: number) => {
        clearFailures.run(subject, observedAt)
        trimFailures.run(subject, observedAt, observedAt)
      }
    }
    // `since` is the earliest failure of the run; source and reason come from
    // the latest one, whatever order the failures arrive in.
    const recordFailure = database.prepare(
      `INSERT INTO work_observed_failures (subject, source, reason, since, last_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (subject) DO UPDATE SET
         since = min(since, excluded.since),
         source = CASE WHEN excluded.last_at >= last_at THEN excluded.source ELSE source END,
         reason = CASE WHEN excluded.last_at >= last_at THEN excluded.reason ELSE reason END,
         last_at = max(last_at, excluded.last_at)`
    )
    const outcomes = prepared.map((item): WorkObserveOutcome => {
      if (item._tag === "future") return { _tag: "stale", subject: item.subject }
      const row = readFact.get(item.subject)
      const stored = row === undefined ? undefined : Schema.decodeUnknownSync(StoredFactRow)(row)
      if (item._tag === "unknown") {
        if (stored !== undefined && stored.confirmedAt >= item.observedAt) {
          return { _tag: "stale", subject: item.subject }
        }
        recordFailure.run(item.subject, item.source, item.reason, item.observedAt, item.observedAt)
        return { _tag: "unknown", reason: item.reason, subject: item.subject }
      }
      if (stored?.observationId === item.observationId) {
        confirmFact.run(item.observedAt, item.subject)
        endFailures.run(item.subject, item.observedAt)
        return { _tag: "unchanged", subject: item.subject }
      }
      if (stored !== undefined && stored.confirmedAt >= item.observedAt) return { _tag: "stale", subject: item.subject }
      upsertFact.run(item.subject, item.observationId, item.observedAt, item.observedAt, item.record)
      endFailures.run(item.subject, item.observedAt)
      return { _tag: "stored", subject: item.subject }
    })
    // Totals are read once and kept current as rows go, so eviction is one
    // indexed lookup and delete per row, not a full rescan per row.
    const evict = (table: string, age: string, payload: string): number => {
      const size = `length(CAST(subject AS BLOB)) + length(CAST(${payload} AS BLOB))`
      const totals = Schema.decodeUnknownSync(FactTotalsRow)(
        database.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(${size}), 0) AS bytes FROM ${table}`).get()
      )
      const oldest = database.prepare(
        `SELECT subject, ${size} AS bytes FROM ${table} ORDER BY ${age} ASC, subject ASC LIMIT 1`
      )
      const remove = database.prepare(`DELETE FROM ${table} WHERE subject = ?`)
      let { bytes, count } = totals
      let evicted = 0
      while (count > workObservedFactMaxRecords || bytes > workObservedFactMaxBytes) {
        const row = Schema.decodeUnknownSync(EvictionRow)(oldest.get())
        remove.run(row.subject)
        count -= 1
        bytes -= row.bytes
        evicted += 1
      }
      return evicted
    }
    // The least recently read rows go first: a fact by its last confirmation,
    // a failure by its latest failed read.
    const evicted = evict("work_observed_facts", "confirmed_at", "record") +
      evict("work_observed_failures", "last_at", "reason")
    database.exec("COMMIT")
    return { evicted, outcomes }
  } catch (cause) {
    if (database.isTransaction) database.exec("ROLLBACK")
    throw cause
  }
}

export class WorkStore implements WorkStoreService {
  readonly #database: DatabaseSync
  readonly #cryptoService: Crypto.Crypto
  readonly #secureFiles: Effect.Effect<void, WorkStoreError>
  readonly path: string

  private constructor(path: string, opened: PrivateSqlite, cryptoService: Crypto.Crypto) {
    this.path = path
    this.#database = opened.database
    this.#secureFiles = opened.secureFiles.pipe(Effect.mapError(fromPrivateDatabaseError))
    this.#cryptoService = cryptoService
  }

  static readonly open = Effect.fn("WorkStore.open")(function*(path: string) {
    const cryptoService = yield* Crypto.Crypto
    const opened = yield* openPrivateSqlite(path, {
      busyTimeoutMillis: workStoreBusyTimeoutMillis,
      initialize: (database) => {
        // One transaction: legacy migration and schema creation succeed or fail
        // together, and their statements share one commit instead of syncing
        // the file once each.
        database.exec("BEGIN IMMEDIATE")
        try {
          migrateLegacyAuthorityTables(database)
          const hadLaneOperationLedger = database.prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'work_lane_operations'"
          ).get() !== undefined
          database.exec(`
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
        -- One row per approved reassignment. Every row commits together with the
        -- goal checkpoint whose event id equals its approval job id, so the
        -- work_goal_events capacity bounds this table too.
        CREATE TABLE IF NOT EXISTS work_goal_reassignments (
          approval_job_id TEXT PRIMARY KEY,
          goal_id TEXT NOT NULL,
          record TEXT NOT NULL
        );
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
        CREATE TABLE IF NOT EXISTS work_observed_facts (
          subject TEXT PRIMARY KEY,
          observation_id TEXT NOT NULL,
          observed_at INTEGER NOT NULL,
          confirmed_at INTEGER NOT NULL,
          record TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS work_observed_facts_age
          ON work_observed_facts (confirmed_at, subject);
        CREATE TABLE IF NOT EXISTS work_observed_failures (
          subject TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          reason TEXT NOT NULL,
          since INTEGER NOT NULL,
          last_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS work_observed_failures_age
          ON work_observed_failures (last_at, subject);
      `)
          const columns = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))(
            database.prepare("PRAGMA table_info(work_goal_events)").all()
          )
          if (!columns.some(({ name }) => name === "transaction_id")) {
            database.exec("ALTER TABLE work_goal_events ADD COLUMN transaction_id TEXT")
          }
          if (!hadLaneOperationLedger) {
            database.exec(`
          INSERT OR IGNORE INTO work_lane_operations
            (operation_id, lane_id, goal_id, phase, revision, record)
          SELECT operation_id, lane_id, goal_id, phase, revision, record
          FROM work_lane_claims
        `)
          }
          database.exec(`
        INSERT OR IGNORE INTO work_lane_operation_totals
          (singleton, operation_count, operation_bytes)
        SELECT 1, COUNT(*), COALESCE(SUM(
          length(CAST(operation_id AS BLOB)) + length(CAST(record AS BLOB))
        ), 0)
        FROM work_lane_operations
      `)
          database.exec(`
        INSERT OR IGNORE INTO work_goal_transaction_totals
          (singleton, transaction_count, transaction_bytes)
        SELECT 1, COUNT(*), COALESCE(SUM(
          length(CAST(transaction_id AS BLOB)) + length(CAST(record AS BLOB))
        ), 0)
        FROM work_goal_transactions
      `)
          database.exec(`
        INSERT OR REPLACE INTO work_decision_totals
          (singleton, decision_count, decision_bytes)
        SELECT 1, COUNT(*), COALESCE(SUM(
          length(CAST(handoff_id AS BLOB)) + length(CAST(record AS BLOB))
        ), 0)
        FROM work_decision_handoffs
      `)
          database.exec("COMMIT")
        } catch (error) {
          // SQLite may already have rolled back (SQLITE_FULL, IOERR); a second
          // ROLLBACK would throw and replace the real error.
          if (database.isTransaction) database.exec("ROLLBACK")
          throw error
        }
      }
    }).pipe(Effect.mapError(fromPrivateDatabaseError))
    return new WorkStore(path, opened, cryptoService)
  })

  readonly recoveryPreflight = Effect.fn("WorkStore.recoveryPreflight")(function*(
    this: WorkStore,
    target: WorkRecoveryTargetType
  ) {
    const decoded = yield* Schema.decodeUnknownEffect(WorkRecoveryTarget)(target).pipe(
      Effect.mapError(storeError("recovery.preflight.decode"))
    )
    const state = yield* Effect.try({
      try: () => readRecoveryState(this.#database, decoded),
      catch: storeError("recovery.preflight.read")
    })
    if (state._tag !== "recoverable") return state
    const historyToken = yield* this.#cryptoService
      .digest("SHA-256", utf8.encode(state.snapshot))
      .pipe(Effect.mapError(storeError("recovery.preflight.digest")), Effect.map(Hex.encode))
    const preflight: WorkRecoveryPreflightType = {
      _tag: "recoverable",
      target: decoded,
      historyToken
    }
    return preflight
  })

  readonly recoverExistingGoal = Effect.fn("WorkStore.recoverExistingGoal")(function*(
    this: WorkStore,
    request: WorkExistingGoalRecoveryType
  ) {
    const decoded = yield* Schema.decodeUnknownEffect(WorkExistingGoalRecovery)(request).pipe(
      Effect.mapError(storeError("recovery.decode"))
    )
    const target = Schema.decodeUnknownSync(WorkRecoveryTarget)(decoded)
    const observedAt = yield* Clock.currentTimeMillis
    yield* this.secureFiles()
    const observed = yield* Effect.try({
      try: () => readRecoveryState(this.#database, target),
      catch: storeError("recovery.inspect")
    })
    const historyToken = observed._tag === "recoverable"
      ? yield* this.#cryptoService
        .digest("SHA-256", utf8.encode(observed.snapshot))
        .pipe(Effect.mapError(storeError("recovery.digest")), Effect.map(Hex.encode))
      : undefined
    const decision = yield* Effect.try({
      try: ():
        | { readonly _tag: "linked"; readonly link: WorkPullRequestLinkType }
        | {
          readonly _tag: "rejected"
          readonly error: WorkAdmissionConflictError | WorkProjectionError
        } =>
      {
        let transaction = false
        const reject = (reason: string): AdmissionRejection => ({
          _tag: "rejected",
          error: admissionConflict(target, reason)
        })
        try {
          this.#database.exec("BEGIN IMMEDIATE")
          transaction = true
          const state = recoveryState(this.#database, target)
          if (state._tag === "existing") {
            const existing = state.link
            const provenance = existing.binding.request.existingGoalRecovery
            this.#database.exec("ROLLBACK")
            transaction = false
            return existing.goalEventId === existing.binding.checkpoint.eventId &&
                existing.lane.revision === 1 &&
                Equal.equals(existing.goal, existing.binding.checkpoint.goal) &&
                existing.binding.request.dispatchRequestId === decoded.operationId &&
                provenance?.expectedGoalEventId === decoded.expectedGoalEventId &&
                provenance.expectedGoalUpdatedAt === decoded.expectedGoalUpdatedAt &&
                provenance.expectedHistoryToken === decoded.expectedHistoryToken &&
                provenance.approvalJobId === decoded.approvalJobId &&
                provenance.approvalActor === decoded.approvalActor &&
                provenance.approvalApprovedBy === decoded.approvalApprovedBy &&
                provenance.approvalApprovedAt === decoded.approvalApprovedAt &&
                provenance.approvalHash === decoded.approvalHash
              ? { _tag: "linked", link: existing }
              : reject("existing linkage is not this exact approved recovery")
          }
          if (
            observed._tag !== "recoverable" ||
            state._tag !== "recoverable" ||
            state.snapshot !== observed.snapshot ||
            historyToken !== decoded.expectedHistoryToken
          ) {
            this.#database.exec("ROLLBACK")
            transaction = false
            return reject(state._tag === "conflict" ? state.reason : "stale complete-history evidence")
          }
          if (
            this.#database
              .prepare(
                `SELECT 1 FROM work_lane_operations WHERE operation_id = ?
             UNION ALL SELECT 1 FROM work_goal_events WHERE event_id = ?
             UNION ALL SELECT 1 FROM work_agent_bindings WHERE dispatch_request_id = ?
             UNION ALL SELECT 1 FROM work_goal_transactions WHERE transaction_id = ?
             UNION ALL SELECT 1 FROM work_decision_handoffs WHERE handoff_id = ? LIMIT 1`
              )
              .get(
                decoded.operationId,
                decoded.operationId,
                decoded.operationId,
                decoded.operationId,
                decoded.operationId
              ) !== undefined
          ) {
            this.#database.exec("ROLLBACK")
            transaction = false
            return reject("operation ID is already used by another durable record")
          }
          const at = Math.max(observedAt, state.original.goal.updatedAt + 1)
          const previous = state.original.goal
          const goal = Schema.decodeUnknownSync(WorkGoal)({
            ...previous,
            repository: {
              repository: decoded.repository,
              branch: decoded.branch
            },
            review: previous.review === null || previous.review === undefined
              ? {
                state: "not_requested",
                summary: null,
                updatedAt: at,
                url: decoded.reviewUrl
              }
              : { ...previous.review, url: decoded.reviewUrl },
            agentHierarchy: { agent: decoded.worker },
            connectTarget: agentConnectTarget(decoded.worker),
            activity: [
              ...(previous.activity ?? []),
              {
                id: decoded.operationId,
                kind: "status",
                summary:
                  `Existing canonical goal linked to settled owner by approved Fleet job ${decoded.approvalJobId}`,
                occurredAt: at
              }
            ],
            updatedAt: at
          })
          const checkpoint = Schema.decodeUnknownSync(WorkGoalCheckpoint)({
            version: "herdr.work.event.v1",
            eventId: decoded.operationId,
            occurredAt: at,
            goal
          })
          const lane = Schema.decodeUnknownSync(WorkLaneClaimed)({
            operationId: decoded.operationId,
            goalId: decoded.goalId,
            laneId: decoded.laneId,
            worktree: decoded.worktree,
            branch: decoded.branch,
            head: decoded.head,
            owner: decoded.owner,
            parent: null,
            phase: "claim",
            expectedRevision: 0,
            revision: 1
          })
          const binding = Schema.decodeUnknownSync(WorkAgentBinding)({
            version: "herdr.work.agent-binding.v1",
            request: {
              version: "herdr.work.agent-binding-request.v1",
              dispatchRequestId: decoded.operationId,
              laneId: decoded.laneId,
              expectedRevision: 0,
              worker: decoded.worker,
              existingGoalRecovery: {
                sessionId: decoded.sessionId,
                workAssignment: decoded.expectedWork,
                baseHead: decoded.baseHead,
                expectedHistoryToken: decoded.expectedHistoryToken,
                expectedGoalEventId: decoded.expectedGoalEventId,
                expectedGoalUpdatedAt: decoded.expectedGoalUpdatedAt,
                approvalJobId: decoded.approvalJobId,
                approvalActor: decoded.approvalActor,
                approvalApprovedBy: decoded.approvalApprovedBy,
                approvalApprovedAt: decoded.approvalApprovedAt,
                approvalHash: decoded.approvalHash
              }
            },
            lane,
            checkpoint
          })
          const operationTotals = readLaneOperationLedgerTotals(this.#database)
          const laneRecord = JSON.stringify(lane)
          const operationBytes = utf8.encode(decoded.operationId).byteLength + utf8.encode(laneRecord).byteLength
          const capacity = agentBindingAdmissionError({
            history: state.history,
            candidate: checkpoint,
            operationCount: operationTotals.operationCount,
            operationBytes: operationTotals.operationBytes,
            candidateOperationBytes: operationBytes
          })
          const lanes = readValidatedLaneLedger(this.#database, "recovery.capacity")
          if (lanes._tag === "invalid") throw lanes.error
          const claimBytes = Schema.decodeUnknownSync(LedgerBytesRow)(
            this.#database
              .prepare(
                `SELECT COALESCE(SUM(length(CAST(lane_id AS BLOB)) + length(CAST(record AS BLOB))), 0) AS bytes
               FROM work_lane_claims`
              )
              .get()
          ).bytes
          if (
            capacity !== undefined ||
            lanes.entries.length >= workLaneMaxRecords ||
            claimBytes + utf8.encode(decoded.laneId).byteLength + utf8.encode(laneRecord).byteLength > workLaneMaxBytes
          ) {
            this.#database.exec("ROLLBACK")
            transaction = false
            return {
              _tag: "rejected",
              error: capacity ??
                new WorkProjectionError({
                  cause: decoded,
                  detail: "existing-goal recovery exceeds Work capacity",
                  reason: "capacity_exceeded"
                })
            }
          }
          const link = Schema.decodeUnknownSync(WorkPullRequestLink)({
            request: {
              repository: decoded.repository,
              pullRequest: decoded.pullRequest,
              goalId: decoded.goalId,
              laneId: decoded.laneId
            },
            goalEventId: checkpoint.eventId,
            goal,
            lane,
            binding
          })
          this.#database
            .prepare(
              `INSERT INTO work_goal_events (event_id, goal_id, occurred_at, record)
             VALUES (?, ?, ?, ?)`
            )
            .run(checkpoint.eventId, checkpoint.goal.id, checkpoint.occurredAt, JSON.stringify(checkpoint))
          this.#database
            .prepare(
              `INSERT INTO work_lane_claims (lane_id, goal_id, operation_id, phase, revision, record)
             VALUES (?, ?, ?, ?, ?, ?)`
            )
            .run(lane.laneId, lane.goalId, lane.operationId, lane.phase, lane.revision, laneRecord)
          this.#database
            .prepare(
              `INSERT INTO work_lane_operations (operation_id, lane_id, goal_id, phase, revision, record)
             VALUES (?, ?, ?, ?, ?, ?)`
            )
            .run(lane.operationId, lane.laneId, lane.goalId, lane.phase, lane.revision, laneRecord)
          this.#database
            .prepare(
              `INSERT INTO work_agent_bindings
             (dispatch_request_id, lane_id, expected_revision, revision, agent_id, host, record)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              decoded.operationId,
              decoded.laneId,
              0,
              1,
              decoded.worker.agentId,
              decoded.worker.host,
              JSON.stringify(binding)
            )
          this.#database.exec("COMMIT")
          transaction = false
          return { _tag: "linked", link }
        } catch (cause) {
          if (transaction) this.#database.exec("ROLLBACK")
          throw cause
        }
      },
      catch: storeError("recovery.transaction")
    })
    if (decision._tag === "rejected") return yield* decision.error
    return decision.link
  })

  readonly reassign = Effect.fn("WorkStore.reassign")(function*(
    this: WorkStore,
    request: WorkGoalReassignmentType
  ) {
    const decoded = yield* Schema.decodeUnknownEffect(WorkGoalReassignment)(request).pipe(
      Effect.mapError(storeError("reassign.decode"))
    )
    const jobId = decoded.approvalJobId
    const observedAt = yield* Clock.currentTimeMillis
    yield* this.secureFiles()
    const decision = yield* Effect.try({
      try: (): ReassignDecision => {
        let transaction = false
        const reject = (error: ReassignRejection): ReassignDecision => {
          this.#database.exec("ROLLBACK")
          transaction = false
          return { _tag: "rejected", error }
        }
        const ownerMismatch = (laneId: string | null, actual: WorkGoalReassignmentType["from"]) =>
          reject(
            new WorkGoalOwnerMismatchError({
              goalId: decoded.goalId,
              laneId,
              expectedOwner: { id: decoded.from.id, name: decoded.from.name },
              actualOwner: { id: actual.id, name: actual.name }
            })
          )
        try {
          this.#database.exec("BEGIN IMMEDIATE")
          transaction = true
          const priorRaw = this.#database
            .prepare(
              `SELECT approval_job_id AS approvalJobId, goal_id AS goalId, record
               FROM work_goal_reassignments WHERE approval_job_id = ?`
            )
            .get(jobId)
          if (priorRaw !== undefined) {
            const row = Schema.decodeUnknownSync(ReassignmentRow)(priorRaw)
            const prior = Schema.decodeUnknownSync(WorkGoalReassigned)(JSON.parse(row.record))
            if (row.approvalJobId !== prior.reassignment.approvalJobId || row.goalId !== prior.reassignment.goalId) {
              return reject(
                new WorkStoreError({ cause: { prior, row }, operation: "reassign.replay.identity-mismatch" })
              )
            }
            if (!Equal.equals(prior.reassignment, decoded)) {
              return reject(new WorkGoalReassignmentConflictError({ approvalJobId: jobId, reason: "payload_mismatch" }))
            }
            this.#database.exec("ROLLBACK")
            transaction = false
            return { _tag: "reassigned", result: prior }
          }
          const collision = this.#database
            .prepare(
              `SELECT 1 FROM work_goal_events WHERE event_id = ?
               UNION ALL SELECT 1 FROM work_lane_operations WHERE operation_id = ?
               UNION ALL SELECT 1 FROM work_agent_bindings WHERE dispatch_request_id = ? LIMIT 1`
            )
            .get(jobId, jobId, jobId)
          if (collision !== undefined) {
            return reject(new WorkGoalReassignmentConflictError({ approvalJobId: jobId, reason: "identifier_in_use" }))
          }
          const eventRows = Schema.decodeUnknownSync(Schema.Array(AgentBindingGoalEventRow))(
            this.#database
              .prepare(
                `SELECT event_id AS eventId, goal_id AS goalId, occurred_at AS occurredAt, record
                 FROM work_goal_events ORDER BY occurred_at ASC, event_id ASC LIMIT ?`
              )
              .all(workHistoryMaxEvents + 1)
          )
          const history: Array<WorkGoalCheckpointType> = []
          for (const row of eventRows) {
            const event = decodeAgentBindingGoalEvent(row, "reassign.history")
            if (event._tag === "invalid") return reject(event.error)
            history.push(event.checkpoint)
          }
          const head = history.filter(({ goal }) => goal.id === decoded.goalId).at(-1)
          if (
            head === undefined ||
            head.eventId !== decoded.expectedGoalEventId ||
            head.goal.updatedAt !== decoded.expectedGoalUpdatedAt
          ) {
            return reject(
              new WorkGoalRevisionConflictError({
                goalId: decoded.goalId,
                expectedEventId: decoded.expectedGoalEventId,
                expectedUpdatedAt: decoded.expectedGoalUpdatedAt,
                actualEventId: head?.eventId ?? null,
                actualUpdatedAt: head?.goal.updatedAt ?? null
              })
            )
          }
          if (!Equal.equals(head.goal.owner, decoded.from)) return ownerMismatch(null, head.goal.owner)
          const ledger = readValidatedLaneLedger(this.#database, "reassign.lane")
          if (ledger._tag === "invalid") return reject(ledger.error)
          const active = ledger.entries.filter(({ claim }) =>
            claim.goalId === decoded.goalId && claim.phase !== "shipped"
          )
          if (active.length > 1) {
            return reject(new WorkStoreError({ cause: active, operation: "reassign.lane.ambiguous" }))
          }
          const current = active[0]
          if (current !== undefined && !Equal.equals(current.claim.owner, decoded.from)) {
            return ownerMismatch(current.claim.laneId, current.claim.owner)
          }
          const latestBindingRaw = current === undefined ? undefined : this.#database
            .prepare(
              `SELECT dispatch_request_id AS dispatchRequestId, lane_id AS laneId,
                 expected_revision AS expectedRevision, revision, agent_id AS agentId, host, record
               FROM work_agent_bindings WHERE lane_id = ? ORDER BY revision DESC LIMIT 1`
            )
            .get(current.claim.laneId)
          const latestBindingRow = latestBindingRaw === undefined
            ? undefined
            : Schema.decodeUnknownSync(AgentBindingRow)(latestBindingRaw)
          const bindingDecision = latestBindingRow === undefined ? null : decodeAgentBindingRow(
            latestBindingRow,
            { dispatchRequestId: latestBindingRow.dispatchRequestId, laneId: latestBindingRow.laneId },
            "reassign.binding"
          )
          if (bindingDecision?._tag === "invalid") return reject(bindingDecision.error)
          const previousBinding = bindingDecision === null ? null : bindingDecision.binding
          if (previousBinding !== null && decoded.toAgent._tag !== "set") {
            return reject(
              new WorkGoalBindingRequiresAgentError({
                goalId: decoded.goalId,
                laneId: previousBinding.request.laneId,
                dispatchRequestId: previousBinding.request.dispatchRequestId
              })
            )
          }
          const previous = head.goal
          const currentAgentId = previous.agentHierarchy?.agent.agentId ?? previous.connectTarget?.agentId
          if (decoded.toAgent._tag === "keep" && currentAgentId !== undefined) {
            return reject(
              new WorkGoalAgentTargetConflictError({
                goalId: decoded.goalId,
                agentId: currentAgentId,
                reason: "keep_existing_target",
                holderId: decoded.goalId
              })
            )
          }
          if (decoded.toAgent._tag === "set") {
            const agentId = decoded.toAgent.agent.agentId
            const agentConflict = (reason: "held_by_other_goal" | "held_by_other_lane", holderId: string) =>
              reject(new WorkGoalAgentTargetConflictError({ goalId: decoded.goalId, agentId, reason, holderId }))
            const latestGoals = new Map<string, WorkGoalCheckpointType["goal"]>()
            for (const { goal } of history) latestGoals.set(goal.id, goal)
            const goalHolder = [...latestGoals.values()].find((goal) =>
              goal.id !== decoded.goalId &&
              (goal.agentHierarchy?.agent.agentId === agentId || goal.connectTarget?.agentId === agentId)
            )
            if (goalHolder !== undefined) return agentConflict("held_by_other_goal", goalHolder.id)
            const holderRows = Schema.decodeUnknownSync(AgentBindingRows)(
              this.#database
                .prepare(
                  `SELECT dispatch_request_id AS dispatchRequestId, lane_id AS laneId,
                     expected_revision AS expectedRevision, revision, agent_id AS agentId, host, record
                   FROM work_agent_bindings ORDER BY dispatch_request_id ASC LIMIT ?`
                )
                .all(workLaneOperationMaxRecords + 1)
            )
            if (holderRows.length > workLaneOperationMaxRecords) {
              return reject(
                new WorkStoreError({ cause: holderRows.length, operation: "reassign.agent-holders.capacity" })
              )
            }
            const holders: Array<WorkAgentBindingType> = []
            for (const row of holderRows) {
              const holder = decodeAgentBindingRow(
                row,
                { dispatchRequestId: row.dispatchRequestId, laneId: row.laneId },
                "reassign.agent-holders"
              )
              if (holder._tag === "invalid") return reject(holder.error)
              holders.push(holder.binding)
            }
            const laneHolder = authoritativeBindings(holders).latest.find(({ lane, request }) =>
              lane.goalId !== decoded.goalId && request.worker.agentId === agentId
            )
            if (laneHolder !== undefined) return agentConflict("held_by_other_lane", laneHolder.request.laneId)
          }
          // occurredAt equals updatedAt for every valid checkpoint; both bound the ordering defensively.
          const at = Math.max(observedAt, head.occurredAt + 1, head.goal.updatedAt + 1)
          const reassigned = {
            ...previous,
            owner: decoded.to,
            activity: [
              ...(previous.activity ?? []),
              {
                id: jobId,
                kind: "status",
                summary: workReassignActivitySummary(decoded, jobId, decoded.approvalHash),
                occurredAt: at
              }
            ],
            updatedAt: at
          }
          const goal = Schema.decodeUnknownSync(WorkGoal)(withReassignedAgent(reassigned, decoded.toAgent))
          const checkpoint = Schema.decodeUnknownSync(WorkGoalCheckpoint)({
            version: "herdr.work.event.v1",
            eventId: jobId,
            occurredAt: at,
            goal
          })
          const lane = current === undefined ? null : Schema.decodeUnknownSync(WorkLaneClaimed)({
            operationId: jobId,
            goalId: current.claim.goalId,
            laneId: current.claim.laneId,
            worktree: current.claim.worktree,
            branch: current.claim.branch,
            head: current.claim.head,
            owner: decoded.to,
            parent: current.claim.parent,
            phase: current.claim.phase,
            expectedRevision: current.claim.revision,
            revision: current.claim.revision + 1
          })
          const binding = previousBinding === null || lane === null || decoded.toAgent._tag !== "set"
            ? null
            : Schema.decodeUnknownSync(WorkAgentBinding)({
              version: "herdr.work.agent-binding.v1",
              request: {
                version: "herdr.work.agent-binding-request.v1",
                dispatchRequestId: jobId,
                laneId: lane.laneId,
                expectedRevision: lane.expectedRevision,
                worker: decoded.toAgent.agent,
                ownerReassignment: {
                  previousDispatchRequestId: previousBinding.request.dispatchRequestId,
                  approvalJobId: jobId,
                  approvalActor: decoded.approvalActor,
                  approvalApprovedBy: decoded.approvalApprovedBy,
                  approvalApprovedAt: decoded.approvalApprovedAt,
                  approvalHash: decoded.approvalHash
                }
              },
              lane,
              checkpoint
            })
          const result = Schema.decodeUnknownSync(WorkGoalReassigned)({
            reassignment: decoded,
            checkpoint,
            lane,
            binding
          })
          const familyError = validateGoalFamilyHistory([...history, checkpoint])
          if (familyError !== undefined) return reject(familyError)
          const laneRecord = lane === null ? null : JSON.stringify(lane)
          // A goal without a lane appends no lane operation, so only a lane rewrite is held to that ledger.
          const operationTotals = lane === null
            ? { operationCount: 0, operationBytes: 0 }
            : readLaneOperationLedgerTotals(this.#database)
          const capacity = agentBindingAdmissionError({
            history,
            candidate: checkpoint,
            operationCount: operationTotals.operationCount,
            operationBytes: operationTotals.operationBytes,
            candidateOperationBytes: laneRecord === null
              ? 0
              : utf8.encode(jobId).byteLength + utf8.encode(laneRecord).byteLength
          })
          if (capacity !== undefined) return reject(capacity)
          if (current !== undefined && laneRecord !== null) {
            const claimBytes = Schema.decodeUnknownSync(LedgerBytesRow)(
              this.#database
                .prepare(
                  `SELECT COALESCE(SUM(length(CAST(lane_id AS BLOB)) + length(CAST(record AS BLOB))), 0) AS bytes
                   FROM work_lane_claims`
                )
                .get()
            ).bytes
            if (
              claimBytes - utf8.encode(current.row.record).byteLength + utf8.encode(laneRecord).byteLength >
                workLaneMaxBytes
            ) {
              return reject(
                new WorkProjectionError({
                  cause: decoded,
                  detail: `work lane claims cannot exceed ${workLaneMaxBytes} encoded bytes`,
                  reason: "capacity_exceeded"
                })
              )
            }
          }
          this.#database
            .prepare("INSERT INTO work_goal_events (event_id, goal_id, occurred_at, record) VALUES (?, ?, ?, ?)")
            .run(checkpoint.eventId, checkpoint.goal.id, checkpoint.occurredAt, JSON.stringify(checkpoint))
          if (lane !== null && laneRecord !== null) {
            const changes = this.#database
              .prepare(
                `UPDATE work_lane_claims SET operation_id = ?, revision = ?, record = ?
                 WHERE lane_id = ? AND revision = ?`
              )
              .run(lane.operationId, lane.revision, laneRecord, lane.laneId, lane.expectedRevision).changes
            if (changes !== 1 && changes !== 1n) {
              return reject(new WorkStoreError({ cause: lane, operation: "reassign.lane.update" }))
            }
            this.#database
              .prepare(
                `INSERT INTO work_lane_operations (operation_id, lane_id, goal_id, phase, revision, record)
                 VALUES (?, ?, ?, ?, ?, ?)`
              )
              .run(lane.operationId, lane.laneId, lane.goalId, lane.phase, lane.revision, laneRecord)
          }
          if (binding !== null) {
            this.#database
              .prepare(
                `INSERT INTO work_agent_bindings
                   (dispatch_request_id, lane_id, expected_revision, revision, agent_id, host, record)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
              )
              .run(
                binding.request.dispatchRequestId,
                binding.request.laneId,
                binding.request.expectedRevision,
                binding.lane.revision,
                binding.request.worker.agentId,
                binding.request.worker.host,
                JSON.stringify(binding)
              )
          }
          this.#database
            .prepare("INSERT INTO work_goal_reassignments (approval_job_id, goal_id, record) VALUES (?, ?, ?)")
            .run(jobId, decoded.goalId, JSON.stringify(result))
          this.#database.exec("COMMIT")
          transaction = false
          return { _tag: "reassigned", result }
        } catch (cause) {
          if (transaction) this.#database.exec("ROLLBACK")
          throw cause
        }
      },
      catch: storeError("reassign.transaction")
    })
    if (decision._tag === "rejected") return yield* decision.error
    return decision.result
  })

  readonly admissionPreflight = Effect.fn("WorkStore.admissionPreflight")(function*(
    this: WorkStore,
    target: WorkAdmissionTargetType
  ) {
    const decoded = yield* Schema.decodeUnknownEffect(WorkAdmissionTarget)(target).pipe(
      Effect.mapError(storeError("admission.preflight.decode"))
    )
    const state = yield* Effect.try({
      try: () => readAdmissionState(this.#database, decoded),
      catch: storeError("admission.preflight.read")
    })
    if (state._tag !== "prospective") return state
    const absenceToken = yield* this.#cryptoService.digest(
      "SHA-256",
      new TextEncoder().encode(state.snapshot)
    ).pipe(
      Effect.mapError(storeError("admission.preflight.digest")),
      Effect.map(Hex.encode)
    )
    const preflight: WorkAdmissionPreflightType = { _tag: "prospective", target: state.target, absenceToken }
    return preflight
  })

  readonly admitExistingOwner = Effect.fn("WorkStore.admitExistingOwner")(function*(
    this: WorkStore,
    request: WorkProspectiveAdmissionType
  ) {
    const decoded = yield* Schema.decodeUnknownEffect(WorkProspectiveAdmission)(request).pipe(
      Effect.mapError(storeError("admission.decode"))
    )
    const target = Schema.decodeUnknownSync(WorkAdmissionTarget)(decoded)
    const now = yield* Clock.currentTimeMillis
    yield* this.secureFiles()
    const observed = yield* Effect.try({
      try: () => readAdmissionState(this.#database, target),
      catch: storeError("admission.inspect")
    })
    const absenceToken = observed._tag === "prospective"
      ? yield* this.#cryptoService.digest("SHA-256", new TextEncoder().encode(observed.snapshot)).pipe(
        Effect.mapError(storeError("admission.digest")),
        Effect.map(Hex.encode)
      )
      : undefined
    const decision = yield* Effect.try({
      try: ():
        | { readonly _tag: "admitted"; readonly link: WorkPullRequestLinkType }
        | { readonly _tag: "rejected"; readonly error: WorkAdmissionConflictError | WorkProjectionError } =>
      {
        let transaction = false
        try {
          this.#database.exec("BEGIN IMMEDIATE")
          transaction = true
          const reject = (reason: string): AdmissionRejection => ({
            _tag: "rejected",
            error: admissionConflict(target, reason)
          })
          const state = admissionState(this.#database, target)
          if (state._tag === "existing") {
            const existing = state.link
            const provenance = existing.binding.request.prospectiveAdmission
            this.#database.exec("ROLLBACK")
            transaction = false
            return existing.binding.request.dispatchRequestId === decoded.operationId &&
                provenance?.expectedAbsenceToken === decoded.expectedAbsenceToken &&
                provenance?.approvalJobId === decoded.approvalJobId &&
                provenance.approvalActor === decoded.approvalActor &&
                existing.goal.title === decoded.title &&
                existing.goal.summary === decoded.summary &&
                existing.goal.detail === decoded.detail
              ? { _tag: "admitted", link: existing }
              : reject("existing admission is not this exact approved operation")
          }
          if (
            state._tag !== "prospective" || observed._tag !== "prospective" ||
            state.snapshot !== observed.snapshot || absenceToken !== decoded.expectedAbsenceToken
          ) {
            this.#database.exec("ROLLBACK")
            transaction = false
            return reject(state._tag === "conflict" ? state.reason : "stale absence evidence")
          }
          if (
            this.#database.prepare(
              `SELECT 1 FROM work_lane_operations WHERE operation_id = ?
             UNION ALL SELECT 1 FROM work_goal_events WHERE event_id IN (?, ?)
             UNION ALL SELECT 1 FROM work_agent_bindings WHERE dispatch_request_id = ? LIMIT 1`
            ).get(decoded.operationId, decoded.operationId, `${decoded.operationId}.admission`, decoded.operationId) !==
              undefined
          ) {
            this.#database.exec("ROLLBACK")
            transaction = false
            return reject("operation ID is already used by another durable record")
          }
          if (now < 1) {
            this.#database.exec("ROLLBACK")
            transaction = false
            return reject("admission clock cannot produce two ordered checkpoints")
          }
          const createdAt = now - 1
          const goal = Schema.decodeUnknownSync(WorkGoal)({
            id: decoded.goalId,
            title: decoded.title,
            summary: decoded.summary,
            detail: decoded.detail,
            state: "review",
            owner: decoded.owner,
            repository: { repository: decoded.repository, branch: decoded.branch },
            spend: null,
            delivery: "pull_request",
            blocker: null,
            connectTarget: null,
            goalFamily: { canonicalGoalId: decoded.goalId, role: "canonical" },
            activity: [{
              id: `${decoded.operationId}.admission`,
              kind: "status",
              summary: `Prospective admission of an existing owner by approved Fleet job ${decoded.approvalJobId}`,
              occurredAt: createdAt
            }],
            review: { state: "requested", summary: null, updatedAt: createdAt, url: decoded.reviewUrl },
            createdAt,
            updatedAt: createdAt
          })
          const initial = Schema.decodeUnknownSync(WorkGoalCheckpoint)({
            version: "herdr.work.event.v1",
            eventId: `${decoded.operationId}.admission`,
            occurredAt: createdAt,
            goal
          })
          const lane = Schema.decodeUnknownSync(WorkLaneClaimed)({
            operationId: decoded.operationId,
            goalId: decoded.goalId,
            laneId: decoded.laneId,
            worktree: decoded.worktree,
            branch: decoded.branch,
            head: decoded.head,
            owner: decoded.owner,
            parent: null,
            phase: "review",
            expectedRevision: 0,
            revision: 1
          })
          const binding = Schema.decodeUnknownSync(WorkAgentBinding)({
            version: "herdr.work.agent-binding.v1",
            request: {
              version: "herdr.work.agent-binding-request.v1",
              dispatchRequestId: decoded.operationId,
              laneId: decoded.laneId,
              expectedRevision: 0,
              worker: decoded.worker,
              prospectiveAdmission: {
                sessionId: decoded.sessionId,
                workAssignment: decoded.expectedWork,
                baseHead: decoded.baseHead,
                expectedAbsenceToken: decoded.expectedAbsenceToken,
                approvalJobId: decoded.approvalJobId,
                approvalActor: decoded.approvalActor
              }
            },
            lane,
            checkpoint: {
              version: "herdr.work.event.v1",
              eventId: decoded.operationId,
              occurredAt: now,
              goal: {
                ...goal,
                agentHierarchy: { agent: decoded.worker },
                connectTarget: agentConnectTarget(decoded.worker),
                updatedAt: now
              }
            }
          })
          const existingRows = Schema.decodeUnknownSync(Schema.Array(AgentBindingGoalEventRow))(
            this.#database.prepare(
              `SELECT event_id AS eventId, goal_id AS goalId, occurred_at AS occurredAt, record
               FROM work_goal_events ORDER BY occurred_at ASC, event_id ASC LIMIT ?`
            ).all(workHistoryMaxEvents + 1)
          )
          const history = existingRows.map((row) => {
            const result = decodeAgentBindingGoalEvent(row, "admission.history")
            if (result._tag === "invalid") throw result.error
            return result.checkpoint
          })
          const operationTotals = readLaneOperationLedgerTotals(this.#database)
          const laneRecord = JSON.stringify(lane)
          const operationBytes = utf8.encode(decoded.operationId).byteLength + utf8.encode(laneRecord).byteLength
          const claimBytes = Schema.decodeUnknownSync(LedgerBytesRow)(
            this.#database.prepare(
              `SELECT COALESCE(SUM(length(CAST(lane_id AS BLOB)) + length(CAST(record AS BLOB))), 0) AS bytes
             FROM work_lane_claims`
            ).get()
          ).bytes
          const capacity = agentBindingAdmissionError({
            history: [...history, initial],
            candidate: binding.checkpoint,
            operationCount: operationTotals.operationCount,
            operationBytes: operationTotals.operationBytes,
            candidateOperationBytes: operationBytes
          })
          const lanes = readValidatedLaneLedger(this.#database, "admission.capacity")
          if (lanes._tag === "invalid") throw lanes.error
          if (
            capacity !== undefined || lanes.entries.length >= workLaneMaxRecords ||
            new Set(history.map(({ goal: previous }) => previous.id)).size >= workSnapshotMaxGoals ||
            claimBytes + utf8.encode(decoded.laneId).byteLength + utf8.encode(laneRecord).byteLength > workLaneMaxBytes
          ) {
            this.#database.exec("ROLLBACK")
            transaction = false
            return {
              _tag: "rejected",
              error: capacity ?? new WorkProjectionError({
                cause: decoded,
                detail: "prospective admission exceeds Work capacity",
                reason: "capacity_exceeded"
              })
            }
          }
          const link = Schema.decodeUnknownSync(WorkPullRequestLink)({
            request: {
              repository: decoded.repository,
              pullRequest: decoded.pullRequest,
              goalId: decoded.goalId,
              laneId: decoded.laneId
            },
            goalEventId: binding.checkpoint.eventId,
            goal: binding.checkpoint.goal,
            lane,
            binding
          })
          this.#database.prepare(
            `INSERT INTO work_goal_events (event_id, goal_id, occurred_at, record)
             VALUES (?, ?, ?, ?)`
          ).run(initial.eventId, initial.goal.id, initial.occurredAt, JSON.stringify(initial))
          this.#database.prepare(
            `INSERT INTO work_goal_events (event_id, goal_id, occurred_at, record)
             VALUES (?, ?, ?, ?)`
          ).run(binding.checkpoint.eventId, decoded.goalId, now, JSON.stringify(binding.checkpoint))
          this.#database.prepare(
            `INSERT INTO work_lane_claims (lane_id, goal_id, operation_id, phase, revision, record)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(lane.laneId, lane.goalId, lane.operationId, lane.phase, lane.revision, laneRecord)
          this.#database.prepare(
            `INSERT INTO work_lane_operations (operation_id, lane_id, goal_id, phase, revision, record)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(lane.operationId, lane.laneId, lane.goalId, lane.phase, lane.revision, laneRecord)
          this.#database.prepare(
            `INSERT INTO work_agent_bindings
             (dispatch_request_id, lane_id, expected_revision, revision, agent_id, host, record)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(
            decoded.operationId,
            decoded.laneId,
            0,
            1,
            decoded.worker.agentId,
            decoded.worker.host,
            JSON.stringify(binding)
          )
          this.#database.exec("COMMIT")
          transaction = false
          return { _tag: "admitted", link }
        } catch (cause) {
          if (transaction) this.#database.exec("ROLLBACK")
          throw cause
        }
      },
      catch: storeError("admission.transaction")
    })
    if (decision._tag === "rejected") return yield* decision.error
    return decision.link
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

  readonly bindingDispatchesForLane = Effect.fn("WorkStore.bindingDispatchesForLane")(function*(
    this: WorkStore,
    laneId: string
  ) {
    const decoded = yield* Schema.decodeUnknownEffect(WorkGoalId)(laneId).pipe(
      Effect.mapError(storeError("agent-binding.lane.decode"))
    )
    const rows = yield* Effect.try({
      try: () =>
        this.#database.prepare(
          `SELECT dispatch_request_id AS dispatchRequestId
         FROM work_agent_bindings WHERE lane_id = ? ORDER BY revision DESC`
        ).all(decoded),
      catch: storeError("agent-binding.lane.read")
    })
    const entries = yield* Schema.decodeUnknownEffect(Schema.Array(
      Schema.Struct({ dispatchRequestId: WorkAgentBindingRequest.fields.dispatchRequestId })
    ))(rows).pipe(Effect.mapError(storeError("agent-binding.lane.rows")))
    return entries.map(({ dispatchRequestId }) => dispatchRequestId)
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
      Effect.map(Hex.encode)
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
                return (
                  row === undefined ||
                  event === undefined ||
                  row.goalId !== event.goal.id ||
                  row.occurredAt !== event.occurredAt
                )
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
              return (
                row === undefined ||
                row.eventId !== event.eventId ||
                row.goalId !== event.goal.id ||
                row.occurredAt !== event.occurredAt
              )
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
              return (
                row === undefined ||
                event === undefined ||
                row.goalId !== event.goal.id ||
                row.occurredAt !== event.occurredAt
              )
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
              ? ({ _tag: "claimed", value: priorClaim } satisfies ClaimDecision)
              : ({
                _tag: "operation-conflict",
                error: new WorkLaneOperationConflictError({ operationId: decoded.operationId })
              } satisfies ClaimDecision)
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
          const reconciliation = decoded.reconciliation
          if (reconciliation !== undefined) {
            const rejectLink = (reason: WorkPullRequestLinkError["reason"]): ClaimDecision => {
              this.#database.exec("ROLLBACK")
              inTransaction = false
              return {
                _tag: "rejected",
                error: new WorkPullRequestLinkError({
                  goalId: decoded.goalId,
                  laneId: decoded.laneId,
                  reason
                })
              }
            }
            if (existingClaim === undefined || existingClaim.goalId !== decoded.goalId) {
              return rejectLink("missing_lane")
            }
            if (existingClaim.revision !== decoded.expectedRevision) return rejectLink("stale_revision")
            if (existingClaim.head !== reconciliation.expectedHead) return rejectLink("head_mismatch")
            if (
              !Equal.equals(existingClaim.owner, reconciliation.expectedOwner) ||
              !Equal.equals(decoded.owner, existingClaim.owner)
            ) return rejectLink("owner_mismatch")
            if (
              existingClaim.worktree !== decoded.worktree ||
              existingClaim.branch !== decoded.branch ||
              existingClaim.parent !== decoded.parent ||
              existingClaim.phase !== decoded.phase ||
              existingClaim.phase === "shipped"
            ) return rejectLink("identity_mismatch")
            const eventRaw = this.#database.prepare(
              `SELECT event_id AS eventId, goal_id AS goalId, occurred_at AS occurredAt, record
               FROM work_goal_events WHERE goal_id = ? ORDER BY occurred_at DESC, event_id DESC LIMIT 1`
            ).get(decoded.goalId)
            if (eventRaw === undefined) return rejectLink("missing_provenance")
            const event = Schema.decodeUnknownSync(WorkGoalCheckpoint)(
              JSON.parse(Schema.decodeUnknownSync(AgentBindingGoalEventRow)(eventRaw).record)
            )
            const goal = event.goal
            if (
              event.eventId !== reconciliation.expectedGoalEventId ||
              goal.review?.url !==
                `https://github.com/${reconciliation.repository}/pull/${reconciliation.pullRequest}` ||
              goal.goalFamily?.role !== "canonical" ||
              goal.goalFamily.canonicalGoalId !== goal.id
            ) return rejectLink("missing_provenance")
            if (goal.state === "completed" || goal.state === "deployed") return rejectLink("terminal_goal")
            if (!Equal.equals(goal.owner, reconciliation.expectedOwner)) return rejectLink("owner_mismatch")
            const bindingRows = Schema.decodeUnknownSync(Schema.Array(AgentBindingRow))(
              this.#database.prepare(
                `SELECT dispatch_request_id AS dispatchRequestId, lane_id AS laneId,
                  expected_revision AS expectedRevision, revision, agent_id AS agentId, host, record
                 FROM work_agent_bindings WHERE lane_id = ? ORDER BY revision DESC`
              ).all(decoded.laneId)
            )
            const latest = bindingRows[0]
            if (latest === undefined) return rejectLink("missing_binding")
            if (latest.dispatchRequestId !== reconciliation.bindingDispatchRequestId) {
              return rejectLink("ambiguous_binding")
            }
            const binding = Schema.decodeUnknownSync(WorkAgentBinding)(JSON.parse(latest.record))
            if (
              binding.request.laneId !== decoded.laneId ||
              binding.lane.goalId !== decoded.goalId ||
              !Equal.equals(binding.request.worker, reconciliation.worker) ||
              !Equal.equals(goal.agentHierarchy?.agent, reconciliation.worker) ||
              goal.connectTarget?.agentId !== reconciliation.worker.agentId ||
              goal.connectTarget.host.toLowerCase() !== reconciliation.worker.host.toLowerCase()
            ) {
              return rejectLink("identity_mismatch")
            }
          }
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
          const facts = this.#database.prepare(
            `SELECT subject, observation_id AS observationId, observed_at AS observedAt,
               confirmed_at AS confirmedAt, record
             FROM work_observed_facts ORDER BY subject ASC
             LIMIT ?`
          ).all(workObservedFactMaxRecords + 1)
          const failures = this.#database.prepare(
            `SELECT subject, source, reason, since, last_at AS lastAt
             FROM work_observed_failures ORDER BY subject ASC LIMIT ?`
          ).all(workObservedFactMaxRecords + 1)
          this.#database.exec("COMMIT")
          inTransaction = false
          return { bindings, events, facts, failures, laneOperations }
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
    const factRows = yield* Schema.decodeUnknownEffect(Schema.Array(ObservedFactRow))(source.facts).pipe(
      Effect.mapError(storeError("snapshot-input.decode-fact-rows"))
    )
    const failures = yield* Schema.decodeUnknownEffect(Schema.Array(WorkObservedFailure))(source.failures).pipe(
      Effect.mapError(storeError("snapshot-input.decode-failures"))
    )
    if (factRows.length > workObservedFactMaxRecords || failures.length > workObservedFactMaxRecords) {
      return yield* new WorkStoreError({ cause: factRows.length, operation: "snapshot-input.fact-capacity" })
    }
    const facts = yield* Effect.forEach(factRows, (row) =>
      Effect.try({
        try: () =>
          Schema.decodeUnknownSync(WorkObservedFact)({
            confirmedAt: row.confirmedAt,
            observation: JSON.parse(row.record),
            observationId: row.observationId,
            observedAt: row.observedAt,
            subject: row.subject
          }),
        catch: storeError("snapshot-input.decode-fact")
      }))
    // A row is filed under its own facts' subject; anything else is a corrupt row.
    const misfiled = facts.find((fact) => fact.subject !== observationSubject(fact.observation))
    if (misfiled !== undefined) {
      return yield* new WorkStoreError({ cause: misfiled.subject, operation: "snapshot-input.fact-subject" })
    }
    return { events, facts, failures, logicalObservedAt }
  })

  readonly observe = Effect.fn("WorkStore.observe")(function*(
    this: WorkStore,
    envelopes: ReadonlyArray<WorkObservationEnvelopeType>
  ) {
    const decoded = yield* Schema.decodeUnknownEffect(
      Schema.Array(WorkObservationEnvelope).check(Schema.isMaxLength(workObservedFactMaxRecords))
    )(envelopes).pipe(Effect.mapError(storeError("observe.decode")))
    const cryptoService = this.#cryptoService
    // An observation from further ahead than clock skew allows would outrank
    // every real reading until wall time caught up, so it is skipped as stale.
    const clockNow = yield* Clock.currentTimeMillis
    const latestAllowed = clockNow + workObservationMaxSkewMillis
    const prepared = yield* Effect.forEach(
      decoded,
      Effect.fnUntraced(function*(envelope) {
        // Composite subjects are bounded on their own; check before anything is written.
        const subject = yield* Schema.decodeUnknownEffect(WorkObservationSubject)(
          observationSubject(envelope.observation)
        ).pipe(Effect.mapError(storeError("observe.subject")))
        if (envelope.observedAt > latestAllowed) return { _tag: "future", subject } satisfies PreparedObservation
        if (envelope.observation._tag === "unknown") {
          if (canonicalSubject(envelope.observation.source, envelope.observation.subject) === null) {
            return yield* new WorkStoreError({ cause: envelope.observation, operation: "observe.subject" })
          }
          return {
            _tag: "unknown",
            // Within the skew allowance, a reading from slightly ahead counts
            // as now, so it is visible to a snapshot taken now.
            observedAt: Math.min(envelope.observedAt, clockNow),
            reason: envelope.observation.reason,
            source: envelope.observation.source,
            subject
          } satisfies PreparedObservation
        }
        // Case-insensitive identities are lowercased so a spelling change is the
        // same fact; encoding emits keys in schema field order, so equal facts
        // give equal text and one id.
        const record = JSON.stringify(
          Schema.encodeSync(WorkObservationEnvelope)({
            ...envelope,
            observation: canonicalObservation(envelope.observation)
          })
            .observation
        )
        const digest = yield* cryptoService.digest("SHA-256", utf8.encode(record)).pipe(
          Effect.mapError(storeError("observe.digest"))
        )
        return {
          _tag: "fact",
          observationId: Hex.encode(digest),
          observedAt: Math.min(envelope.observedAt, clockNow),
          record,
          subject
        } satisfies PreparedObservation
      })
    )
    yield* this.secureFiles()
    const report = yield* Effect.try({
      try: () => writeObservations(this.#database, prepared),
      catch: storeError("observe.write")
    })
    // The write may have created the WAL siblings; they get the same private mode.
    yield* this.secureFiles()
    return report
  })

  private secureFiles() {
    return this.#secureFiles
  }

  close(): void {
    this.#database.close()
  }
}
