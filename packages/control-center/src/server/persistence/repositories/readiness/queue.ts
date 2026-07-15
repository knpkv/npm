import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"

import { EnvironmentId, ReleaseId, WorkspaceId } from "../../../../domain/identifiers.js"
import { UtcTimestamp } from "../../../../domain/utcTimestamp.js"
import { Database } from "../../Database.js"
import { PersistenceOperationError } from "../../errors.js"
import { readChanges } from "../internal.js"
import {
  type ClaimReadinessInvalidationRequest,
  type EnqueueAffectedReadinessRequest,
  type EnqueueDueReadinessEvaluationsRequest,
  type EnqueueReadinessInvalidationRequest,
  ReadinessInputError,
  type ReadinessInvalidationRecord,
  ReadinessInvalidationRevision,
  ReadinessLeaseToken
} from "./contract.js"
import { ReadinessEnvironmentQueueRow, ReadinessReleaseQueueRow } from "./rows.js"

const encodeTimestamp = Schema.encodeSync(UtcTimestamp)
const MAX_READINESS_LEASE_MILLISECONDS = 15 * 60 * 1_000

const DueScheduleRow = Schema.Struct({
  workspaceId: WorkspaceId,
  releaseId: ReleaseId,
  environmentId: EnvironmentId,
  assessmentId: Schema.String,
  dueAt: Schema.String
})

const AffectedEnvironmentRow = Schema.Struct({
  workspaceId: WorkspaceId,
  releaseId: ReleaseId,
  environmentId: EnvironmentId
})

export const makeReadinessQueue = Effect.gen(function*() {
  const database = yield* Database
  const cryptoService = yield* Crypto.Crypto
  const sql = database.sql

  const readEnvironmentQueue = SqlSchema.findOne({
    Request: Schema.Struct({ workspaceId: WorkspaceId, releaseId: ReleaseId, environmentId: EnvironmentId }),
    Result: ReadinessEnvironmentQueueRow,
    execute: ({ environmentId, releaseId, workspaceId }) =>
      sql`SELECT workspace_id AS workspaceId, release_id AS releaseId,
                 environment_id AS environmentId, invalidation_revision AS invalidationRevision,
                 reason, source_evidence_id AS sourceEvidenceId,
                 source_plugin_connection_id AS sourcePluginConnectionId,
                 queued_at AS queuedAt, available_at AS availableAt, attempts,
                 claim_owner AS claimOwner, claim_token AS claimToken,
                 claim_expires_at AS claimExpiresAt
          FROM readiness_environment_queue
          WHERE workspace_id = ${workspaceId} AND release_id = ${releaseId}
            AND environment_id = ${environmentId}`
  })

  const readReleaseQueue = SqlSchema.findOne({
    Request: Schema.Struct({ workspaceId: WorkspaceId, releaseId: ReleaseId }),
    Result: ReadinessReleaseQueueRow,
    execute: ({ releaseId, workspaceId }) =>
      sql`SELECT workspace_id AS workspaceId, release_id AS releaseId,
                 invalidation_revision AS invalidationRevision, reason,
                 source_environment_id AS sourceEnvironmentId,
                 queued_at AS queuedAt, available_at AS availableAt, attempts,
                 claim_owner AS claimOwner, claim_token AS claimToken,
                 claim_expires_at AS claimExpiresAt
          FROM readiness_release_queue
          WHERE workspace_id = ${workspaceId} AND release_id = ${releaseId}`
  })

  const environmentRecord = Effect.fn("ReadinessQueue.environmentRecord")(function*(
    row: typeof ReadinessEnvironmentQueueRow.Type,
    lease: null | {
      readonly owner: ClaimReadinessInvalidationRequest["leaseOwner"]
      readonly token: typeof ReadinessLeaseToken.Type
      readonly claimedAt: UtcTimestamp
      readonly expiresAt: UtcTimestamp
    }
  ): Effect.fn.Return<ReadinessInvalidationRecord, Schema.SchemaError> {
    return {
      _tag: "environment",
      workspaceId: row.workspaceId,
      releaseId: row.releaseId,
      environmentId: row.environmentId,
      invalidationRevision: yield* Schema.decodeUnknownEffect(ReadinessInvalidationRevision)(
        row.invalidationRevision
      ),
      reason: row.reason,
      enqueuedAt: yield* Schema.decodeUnknownEffect(UtcTimestamp)(row.queuedAt),
      lease
    }
  })

  const releaseRecord = Effect.fn("ReadinessQueue.releaseRecord")(function*(
    row: typeof ReadinessReleaseQueueRow.Type,
    lease: null | {
      readonly owner: ClaimReadinessInvalidationRequest["leaseOwner"]
      readonly token: typeof ReadinessLeaseToken.Type
      readonly claimedAt: UtcTimestamp
      readonly expiresAt: UtcTimestamp
    }
  ): Effect.fn.Return<ReadinessInvalidationRecord, Schema.SchemaError> {
    return {
      _tag: "release",
      workspaceId: row.workspaceId,
      releaseId: row.releaseId,
      invalidationRevision: yield* Schema.decodeUnknownEffect(ReadinessInvalidationRevision)(
        row.invalidationRevision
      ),
      reason: row.reason,
      enqueuedAt: yield* Schema.decodeUnknownEffect(UtcTimestamp)(row.queuedAt),
      lease
    }
  })

  const enqueue = Effect.fn("ReadinessQueue.enqueue")(function*(request: EnqueueReadinessInvalidationRequest) {
    const timestamp = encodeTimestamp(request.enqueuedAt)
    if (request._tag === "environment") {
      yield* sql`INSERT INTO readiness_environment_queue (
        workspace_id, release_id, environment_id, invalidation_revision, reason,
        source_evidence_id, source_plugin_connection_id, queued_at, available_at,
        attempts, claim_owner, claim_token, claim_expires_at
      ) VALUES (
        ${request.workspaceId}, ${request.releaseId}, ${request.environmentId}, 1,
        ${request.reason}, NULL, NULL, ${timestamp}, ${timestamp}, 0, NULL, NULL, NULL
      ) ON CONFLICT (workspace_id, release_id, environment_id) DO UPDATE SET
        invalidation_revision = readiness_environment_queue.invalidation_revision + 1,
        reason = excluded.reason, source_evidence_id = NULL, source_plugin_connection_id = NULL,
        queued_at = excluded.queued_at, available_at = excluded.available_at,
        claim_owner = NULL, claim_token = NULL, claim_expires_at = NULL`
      return yield* environmentRecord(yield* readEnvironmentQueue(request), null)
    }
    yield* sql`INSERT INTO readiness_release_queue (
      workspace_id, release_id, invalidation_revision, reason, source_environment_id,
      queued_at, available_at, attempts, claim_owner, claim_token, claim_expires_at
    ) VALUES (
      ${request.workspaceId}, ${request.releaseId}, 1, ${request.reason}, NULL,
      ${timestamp}, ${timestamp}, 0, NULL, NULL, NULL
    ) ON CONFLICT (workspace_id, release_id) DO UPDATE SET
      invalidation_revision = readiness_release_queue.invalidation_revision + 1,
      reason = excluded.reason, source_environment_id = NULL,
      queued_at = excluded.queued_at, available_at = excluded.available_at,
      claim_owner = NULL, claim_token = NULL, claim_expires_at = NULL`
    return yield* releaseRecord(yield* readReleaseQueue(request), null)
  })

  const claim = Effect.fn("ReadinessQueue.claim")(function*(request: ClaimReadinessInvalidationRequest) {
    const claimedAtValue = yield* DateTime.now
    if (DateTime.Order(claimedAtValue, request.leaseExpiresAt) >= 0) return null
    if (
      DateTime.toEpochMillis(request.leaseExpiresAt) - DateTime.toEpochMillis(claimedAtValue) >
        MAX_READINESS_LEASE_MILLISECONDS
    ) {
      return yield* new ReadinessInputError({ operation: "claim-invalidation", reason: "invalid-request" })
    }
    const claimedAt = encodeTimestamp(claimedAtValue)
    const expiresAt = encodeTimestamp(request.leaseExpiresAt)
    const token = ReadinessLeaseToken.make(
      yield* cryptoService.randomUUIDv7.pipe(
        Effect.mapError(() => new PersistenceOperationError({ operation: "readiness.claim-token" }))
      )
    )
    if (request._tag === "environment") {
      yield* sql`UPDATE readiness_environment_queue
        SET claim_owner = ${request.leaseOwner}, claim_token = ${token},
            claim_expires_at = ${expiresAt}, attempts = attempts + 1
        WHERE workspace_id = ${request.workspaceId} AND release_id = ${request.releaseId}
          AND environment_id = ${request.environmentId}
          AND invalidation_revision = ${request.expectedInvalidationRevision}
          AND available_at <= ${claimedAt}
          AND (claim_owner IS NULL OR claim_expires_at <= ${claimedAt})`
      if ((yield* readChanges(sql)) === 0) return null
      const row = yield* readEnvironmentQueue(request)
      return yield* environmentRecord(row, {
        owner: request.leaseOwner,
        token,
        claimedAt: claimedAtValue,
        expiresAt: request.leaseExpiresAt
      })
    }
    yield* sql`UPDATE readiness_release_queue
      SET claim_owner = ${request.leaseOwner}, claim_token = ${token},
          claim_expires_at = ${expiresAt}, attempts = attempts + 1
      WHERE workspace_id = ${request.workspaceId} AND release_id = ${request.releaseId}
        AND invalidation_revision = ${request.expectedInvalidationRevision}
        AND available_at <= ${claimedAt}
        AND (claim_owner IS NULL OR claim_expires_at <= ${claimedAt})`
    if ((yield* readChanges(sql)) === 0) return null
    const row = yield* readReleaseQueue(request)
    return yield* releaseRecord(row, {
      owner: request.leaseOwner,
      token,
      claimedAt: claimedAtValue,
      expiresAt: request.leaseExpiresAt
    })
  })

  const enqueueDue = Effect.fn("ReadinessQueue.enqueueDue")(function*(request: EnqueueDueReadinessEvaluationsRequest) {
    const dueAt = encodeTimestamp(request.dueAt)
    const schedules = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: DueScheduleRow,
      execute: () =>
        sql`SELECT workspace_id AS workspaceId, release_id AS releaseId,
                                 environment_id AS environmentId, assessment_id AS assessmentId,
                                 due_at AS dueAt
                          FROM readiness_evaluation_schedules
                          WHERE workspace_id = ${request.workspaceId} AND due_at <= ${dueAt}
                          ORDER BY due_at, release_id, environment_id
                          LIMIT ${request.limit}`
    })(undefined)
    yield* Effect.forEach(
      schedules,
      (schedule) =>
        Effect.gen(function*() {
          yield* enqueue({
            _tag: "environment",
            workspaceId: schedule.workspaceId,
            releaseId: schedule.releaseId,
            environmentId: schedule.environmentId,
            reason: "scheduled",
            enqueuedAt: request.dueAt
          })
          yield* sql`DELETE FROM readiness_evaluation_schedules
        WHERE workspace_id = ${schedule.workspaceId} AND release_id = ${schedule.releaseId}
          AND environment_id = ${schedule.environmentId}
          AND assessment_id = ${schedule.assessmentId} AND due_at = ${schedule.dueAt}`
        }),
      { discard: true }
    )
    return { enqueued: schedules.length }
  })

  const enqueueAffected = Effect.fn("ReadinessQueue.enqueueAffected")(function*(
    request: EnqueueAffectedReadinessRequest
  ) {
    const affected = yield* request._tag === "evidence"
      ? SqlSchema.findAll({
        Request: Schema.Void,
        Result: AffectedEnvironmentRow,
        execute: () =>
          sql`SELECT head.workspace_id AS workspaceId,
                                   head.release_id AS releaseId,
                                   head.environment_id AS environmentId
                            FROM readiness_environment_heads head
                            INNER JOIN readiness_assessment_evidence dependency
                              ON dependency.workspace_id = head.workspace_id
                             AND dependency.assessment_id = head.assessment_id
                            WHERE head.workspace_id = ${request.workspaceId}
                              AND dependency.evidence_id = ${request.evidenceId}
                            ORDER BY head.release_id, head.environment_id`
      })(undefined)
      : SqlSchema.findAll({
        Request: Schema.Void,
        Result: AffectedEnvironmentRow,
        execute: () =>
          sql`SELECT head.workspace_id AS workspaceId,
                                   head.release_id AS releaseId,
                                   head.environment_id AS environmentId
                            FROM readiness_environment_heads head
                            INNER JOIN readiness_assessment_sources dependency
                              ON dependency.workspace_id = head.workspace_id
                             AND dependency.assessment_id = head.assessment_id
                            WHERE head.workspace_id = ${request.workspaceId}
                              AND dependency.plugin_connection_id = ${request.pluginConnectionId}
                            ORDER BY head.release_id, head.environment_id`
      })(undefined)
    const timestamp = encodeTimestamp(request.enqueuedAt)
    yield* Effect.forEach(
      affected,
      (target) =>
        sql`INSERT INTO readiness_environment_queue (
        workspace_id, release_id, environment_id, invalidation_revision, reason,
        source_evidence_id, source_plugin_connection_id, queued_at, available_at,
        attempts, claim_owner, claim_token, claim_expires_at
      ) VALUES (
        ${target.workspaceId}, ${target.releaseId}, ${target.environmentId}, 1,
        ${request._tag === "evidence" ? "evidence-changed" : "plugin-health-changed"},
        ${request._tag === "evidence" ? request.evidenceId : null},
        ${request._tag === "plugin" ? request.pluginConnectionId : null},
        ${timestamp}, ${timestamp}, 0, NULL, NULL, NULL
      ) ON CONFLICT (workspace_id, release_id, environment_id) DO UPDATE SET
        invalidation_revision = readiness_environment_queue.invalidation_revision + 1,
        reason = excluded.reason, source_evidence_id = excluded.source_evidence_id,
        source_plugin_connection_id = excluded.source_plugin_connection_id,
        queued_at = excluded.queued_at, available_at = excluded.available_at,
        claim_owner = NULL, claim_token = NULL, claim_expires_at = NULL`,
      { discard: true }
    )
    const releaseIds = Array.from(new Set(affected.map(({ releaseId }) => releaseId)))
    return { environments: affected.length, releases: releaseIds.length }
  })

  return { claim, enqueue, enqueueAffected, enqueueDue }
})
