/** Bounded, policy-driven retention with immutable cleanup attribution. @module */
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import { WorkspaceId } from "../../../domain/identifiers.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { Database } from "../Database.js"
import { PersistenceOperationError } from "../errors.js"
import { mapPersistenceOperation } from "./internal.js"
import { type RecordRevision, RecordRevision as RecordRevisionSchema } from "./models.js"
import { WorkspaceSettingsRepository } from "./workspaceSettingsRepository.js"

const AUDIT_REPLAY_BATCH_LIMIT = 512
const REPRODUCIBLE_CONTENT_BATCH_LIMIT = 64
const EVIDENCE_BATCH_LIMIT = 64
const AGENT_CONTENT_BATCH_LIMIT = 8
const SANDBOX_ARTIFACT_BATCH_LIMIT = 512

/** Durable retention classes whose policy application is independently audited. */
export const RetentionClass = Schema.Literals([
  "audit-replay",
  "reproducible-content",
  "evidence",
  "agent-content",
  "sandbox-artifact"
])
export type RetentionClass = typeof RetentionClass.Type

/** Immutable summary of one committed bounded cleanup transaction. */
export const RetentionCleanupRun = Schema.Struct({
  workspaceId: WorkspaceId,
  runId: Schema.String.check(Schema.isUUID(7)),
  retentionClass: RetentionClass,
  policyRevision: RecordRevisionSchema,
  cutoffAt: UtcTimestamp,
  batchLimit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 512 })),
  selectedCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  deletedCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  completedAt: UtcTimestamp
})
export type RetentionCleanupRun = typeof RetentionCleanupRun.Type
type EncodedUtcTimestamp = typeof UtcTimestamp.Encoded

/** Internal bounded retention operations for one exact-schema database. */
export interface RetentionRepositoryService {
  readonly listRuns: (
    workspaceId: WorkspaceId
  ) => Effect.Effect<ReadonlyArray<RetentionCleanupRun>, PersistenceOperationError>
  readonly recordSandboxReconciliation: (
    workspaceId: WorkspaceId,
    removedCount: number
  ) => Effect.Effect<ReadonlyArray<RetentionCleanupRun>, PersistenceOperationError>
  readonly sweepWorkspace: (
    workspaceId: WorkspaceId
  ) => Effect.Effect<ReadonlyArray<RetentionCleanupRun>, PersistenceOperationError>
}

const EventCursorRow = Schema.Struct({
  eventCursor: Schema.Int.check(Schema.isGreaterThan(0))
})
const CacheCandidateRow = Schema.Struct({
  rowId: Schema.Int.check(Schema.isGreaterThan(0))
})
const EvidenceCandidateRow = Schema.Struct({
  evidenceId: Schema.String
})
const AgentCandidateRow = Schema.Struct({
  jobId: Schema.String
})

const decodeRows = <Row extends Schema.Top>(schema: Row, rows: unknown) =>
  Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(
    Effect.mapError(() => new PersistenceOperationError({ operation: "retention.decode" }))
  )

const makeRetentionRepository: Effect.Effect<
  RetentionRepositoryService,
  never,
  Crypto.Crypto | Database | WorkspaceSettingsRepository
> = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const database = yield* Database
  const workspaceSettings = yield* WorkspaceSettingsRepository
  const sql = database.sql

  const recordRun = Effect.fn("RetentionRepository.recordRun")(function*(
    workspaceId: WorkspaceId,
    retentionClass: RetentionClass,
    policyRevision: RecordRevision,
    cutoffAt: EncodedUtcTimestamp,
    batchLimit: number,
    selectedCount: number,
    deletedCount: number,
    completedAt: EncodedUtcTimestamp
  ) {
    const runId = yield* cryptoService.randomUUIDv7.pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "retention.identity" }))
    )
    yield* sql`INSERT INTO retention_cleanup_runs (
        workspace_id, run_id, retention_class, policy_revision, cutoff_at,
        batch_limit, selected_count, deleted_count, completed_at
      ) VALUES (
        ${workspaceId}, ${runId}, ${retentionClass}, ${policyRevision}, ${cutoffAt},
        ${batchLimit}, ${selectedCount}, ${deletedCount}, ${completedAt}
      )`
    return RetentionCleanupRun.make({
      workspaceId,
      runId,
      retentionClass,
      policyRevision,
      cutoffAt: DateTime.makeUnsafe(cutoffAt),
      batchLimit,
      selectedCount,
      deletedCount,
      completedAt: DateTime.makeUnsafe(completedAt)
    })
  })

  const sweepAuditReplay = Effect.fn("RetentionRepository.sweepAuditReplay")(function*(
    workspaceId: WorkspaceId,
    policyRevision: RecordRevision,
    cutoffAt: EncodedUtcTimestamp,
    completedAt: EncodedUtcTimestamp
  ) {
    return yield* database
      .transaction(
        Effect.gen(function*() {
          const selected = yield* sql`SELECT event_cursor AS eventCursor
        FROM domain_events
        WHERE workspace_id = ${workspaceId}
          AND ingested_at <= ${cutoffAt}
        ORDER BY event_cursor
        LIMIT ${AUDIT_REPLAY_BATCH_LIMIT}`.pipe(Effect.flatMap((rows) => decodeRows(EventCursorRow, rows)))
          const run = yield* recordRun(
            workspaceId,
            "audit-replay",
            policyRevision,
            cutoffAt,
            AUDIT_REPLAY_BATCH_LIMIT,
            selected.length,
            selected.length,
            completedAt
          )
          if (selected.length === 0) return run
          const deleted = yield* sql`DELETE FROM domain_events
        WHERE workspace_id = ${workspaceId}
          AND event_cursor IN (
            SELECT event_cursor
            FROM domain_events
            WHERE workspace_id = ${workspaceId}
              AND ingested_at <= ${cutoffAt}
            ORDER BY event_cursor
            LIMIT ${AUDIT_REPLAY_BATCH_LIMIT}
          )
        RETURNING event_cursor AS eventCursor`.pipe(Effect.flatMap((rows) => decodeRows(EventCursorRow, rows)))
          if (deleted.length !== selected.length) {
            return yield* new PersistenceOperationError({ operation: "retention.audit-replay-count" })
          }
          const prunedThrough = deleted.reduce((maximum, row) => Math.max(maximum, row.eventCursor), 0)
          yield* sql`UPDATE domain_event_streams
        SET pruned_through_cursor = MAX(pruned_through_cursor, ${prunedThrough})
        WHERE workspace_id = ${workspaceId}`
          return run
        })
      )
      .pipe(mapPersistenceOperation("retention.audit-replay"))
  })

  const sweepReproducibleContent = Effect.fn("RetentionRepository.sweepReproducibleContent")(function*(
    workspaceId: WorkspaceId,
    policyRevision: RecordRevision,
    cutoffAt: EncodedUtcTimestamp,
    completedAt: EncodedUtcTimestamp
  ) {
    return yield* database
      .transaction(
        Effect.gen(function*() {
          const selected = yield* sql`SELECT rowid AS rowId
        FROM diff_content_cache_entries
        WHERE workspace_id = ${workspaceId}
          AND cached_at <= ${cutoffAt}
        ORDER BY cached_at, rowid
        LIMIT ${REPRODUCIBLE_CONTENT_BATCH_LIMIT}`.pipe(Effect.flatMap((rows) => decodeRows(CacheCandidateRow, rows)))
          const run = yield* recordRun(
            workspaceId,
            "reproducible-content",
            policyRevision,
            cutoffAt,
            REPRODUCIBLE_CONTENT_BATCH_LIMIT,
            selected.length,
            selected.length,
            completedAt
          )
          if (selected.length === 0) return run
          yield* sql`INSERT INTO diff_content_cache_cleanup (
          workspace_id, content_digest, requested_at
        )
        SELECT DISTINCT entries.workspace_id, entries.content_digest, ${completedAt}
        FROM diff_content_cache_entries entries
        JOIN content_blobs blobs
          ON blobs.workspace_id = entries.workspace_id
          AND blobs.digest = entries.content_digest
        WHERE entries.rowid IN (
          SELECT rowid
          FROM diff_content_cache_entries
          WHERE workspace_id = ${workspaceId}
            AND cached_at <= ${cutoffAt}
          ORDER BY cached_at, rowid
          LIMIT ${REPRODUCIBLE_CONTENT_BATCH_LIMIT}
        )
          AND blobs.storage_class = 'reproducible-cache'
        ON CONFLICT (workspace_id, content_digest) DO NOTHING`
          const deleted = yield* sql`DELETE FROM diff_content_cache_entries
        WHERE rowid IN (
          SELECT rowid
          FROM diff_content_cache_entries
          WHERE workspace_id = ${workspaceId}
            AND cached_at <= ${cutoffAt}
          ORDER BY cached_at, rowid
          LIMIT ${REPRODUCIBLE_CONTENT_BATCH_LIMIT}
        )
        RETURNING rowid AS rowId`.pipe(Effect.flatMap((rows) => decodeRows(CacheCandidateRow, rows)))
          if (deleted.length !== selected.length) {
            return yield* new PersistenceOperationError({ operation: "retention.reproducible-content-count" })
          }
          return run
        })
      )
      .pipe(mapPersistenceOperation("retention.reproducible-content"))
  })

  const sweepEvidence = Effect.fn("RetentionRepository.sweepEvidence")(function*(
    workspaceId: WorkspaceId,
    policyRevision: RecordRevision,
    completedAt: EncodedUtcTimestamp
  ) {
    const cutoffAt = completedAt
    return yield* database
      .transaction(
        Effect.gen(function*() {
          const candidates = () =>
            sql`SELECT evidence.evidence_id AS evidenceId
          FROM evidence_items evidence
          WHERE evidence.workspace_id = ${workspaceId}
            AND evidence.legal_hold = 0
            AND evidence.retain_until IS NOT NULL
            AND evidence.retain_until <= ${cutoffAt}
            AND NOT EXISTS (
              SELECT 1 FROM evidence_claims claim
              WHERE claim.workspace_id = evidence.workspace_id
                AND claim.evidence_id = evidence.evidence_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM readiness_assessment_evidence assessment
              WHERE assessment.workspace_id = evidence.workspace_id
                AND assessment.evidence_id = evidence.evidence_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM readiness_environment_queue queue
              WHERE queue.workspace_id = evidence.workspace_id
                AND queue.source_evidence_id = evidence.evidence_id
            )
          ORDER BY evidence.retain_until, evidence.evidence_id
          LIMIT ${EVIDENCE_BATCH_LIMIT}`
          const selected = yield* candidates().pipe(Effect.flatMap((rows) => decodeRows(EvidenceCandidateRow, rows)))
          const run = yield* recordRun(
            workspaceId,
            "evidence",
            policyRevision,
            cutoffAt,
            EVIDENCE_BATCH_LIMIT,
            selected.length,
            selected.length,
            completedAt
          )
          if (selected.length === 0) return run
          yield* Effect.forEach(
            selected,
            ({ evidenceId }) =>
              sql`INSERT INTO retention_cleanup_claims (
              workspace_id, run_id, retention_class, record_key
            ) VALUES (${workspaceId}, ${run.runId}, 'evidence', ${evidenceId})`,
            { discard: true }
          )
          const deleted = yield* sql`DELETE FROM evidence_items
        WHERE workspace_id = ${workspaceId}
          AND evidence_id IN (
            SELECT evidence.evidence_id
            FROM evidence_items evidence
            WHERE evidence.workspace_id = ${workspaceId}
              AND evidence.legal_hold = 0
              AND evidence.retain_until IS NOT NULL
              AND evidence.retain_until <= ${cutoffAt}
              AND NOT EXISTS (
                SELECT 1 FROM evidence_claims claim
                WHERE claim.workspace_id = evidence.workspace_id
                  AND claim.evidence_id = evidence.evidence_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM readiness_assessment_evidence assessment
                WHERE assessment.workspace_id = evidence.workspace_id
                  AND assessment.evidence_id = evidence.evidence_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM readiness_environment_queue queue
                WHERE queue.workspace_id = evidence.workspace_id
                  AND queue.source_evidence_id = evidence.evidence_id
              )
            ORDER BY evidence.retain_until, evidence.evidence_id
            LIMIT ${EVIDENCE_BATCH_LIMIT}
          )
        RETURNING evidence_id AS evidenceId`.pipe(Effect.flatMap((rows) => decodeRows(EvidenceCandidateRow, rows)))
          if (deleted.length !== selected.length) {
            return yield* new PersistenceOperationError({ operation: "retention.evidence-count" })
          }
          yield* sql`DELETE FROM retention_cleanup_claims
        WHERE workspace_id = ${workspaceId}
          AND run_id = ${run.runId}`
          return run
        })
      )
      .pipe(mapPersistenceOperation("retention.evidence"))
  })

  const sweepAgentContent = Effect.fn("RetentionRepository.sweepAgentContent")(function*(
    workspaceId: WorkspaceId,
    policyRevision: RecordRevision,
    cutoffAt: EncodedUtcTimestamp,
    completedAt: EncodedUtcTimestamp
  ) {
    const candidateQuery = () =>
      sql`SELECT job.job_id AS jobId
        FROM agent_jobs job
        WHERE job.workspace_id = ${workspaceId}
          AND job.state IN ('succeeded', 'failed', 'cancelled')
          AND job.terminal_at IS NOT NULL
          AND job.terminal_at <= ${cutoffAt}
          AND NOT EXISTS (
            SELECT 1 FROM agent_review_suggestion_publications publication
            WHERE publication.workspace_id = job.workspace_id
              AND publication.job_id = job.job_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM audit_events audit
            WHERE audit.workspace_id = job.workspace_id
              AND audit.job_id = job.job_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM governed_action_transitions transition_record
            WHERE transition_record.workspace_id = job.workspace_id
              AND transition_record.cause_job_id = job.job_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM domain_events event
            WHERE event.workspace_id = job.workspace_id
              AND event.job_id = job.job_id
          )
        ORDER BY job.terminal_at, job.job_id
        LIMIT ${AGENT_CONTENT_BATCH_LIMIT}`
    return yield* database
      .transaction(
        Effect.gen(function*() {
          const selected = yield* candidateQuery().pipe(Effect.flatMap((rows) => decodeRows(AgentCandidateRow, rows)))
          const run = yield* recordRun(
            workspaceId,
            "agent-content",
            policyRevision,
            cutoffAt,
            AGENT_CONTENT_BATCH_LIMIT,
            selected.length,
            selected.length,
            completedAt
          )
          if (selected.length === 0) return run
          const jobIds = selected.map(({ jobId }) => jobId)
          yield* Effect.forEach(
            jobIds,
            (jobId) =>
              sql`INSERT INTO retention_cleanup_claims (
              workspace_id, run_id, retention_class, record_key
            ) VALUES (${workspaceId}, ${run.runId}, 'agent-content', ${jobId})`,
            { discard: true }
          )
          yield* sql`DELETE FROM agent_review_suggestion_revisions
        WHERE workspace_id = ${workspaceId}
          AND source_job_id IN ${sql.in(jobIds)}`
          yield* sql`DELETE FROM agent_thread_events
        WHERE workspace_id = ${workspaceId}
          AND job_id IN ${sql.in(jobIds)}`
          yield* sql`DELETE FROM agent_job_leases
        WHERE workspace_id = ${workspaceId}
          AND job_id IN ${sql.in(jobIds)}`
          yield* sql`DELETE FROM agent_job_attempts
        WHERE workspace_id = ${workspaceId}
          AND job_id IN ${sql.in(jobIds)}`
          const deleted = yield* sql`DELETE FROM agent_jobs
        WHERE workspace_id = ${workspaceId}
          AND job_id IN ${sql.in(jobIds)}
        RETURNING job_id AS jobId`.pipe(Effect.flatMap((rows) => decodeRows(AgentCandidateRow, rows)))
          if (deleted.length !== selected.length) {
            return yield* new PersistenceOperationError({ operation: "retention.agent-content-count" })
          }
          yield* sql`DELETE FROM retention_cleanup_claims
        WHERE workspace_id = ${workspaceId}
          AND run_id = ${run.runId}`
          return run
        })
      )
      .pipe(mapPersistenceOperation("retention.agent-content"))
  })

  return {
    listRuns: Effect.fn("RetentionRepository.listRuns")(function*(workspaceId: WorkspaceId) {
      const rows = yield* sql`SELECT
          workspace_id AS workspaceId,
          run_id AS runId,
          retention_class AS retentionClass,
          policy_revision AS policyRevision,
          cutoff_at AS cutoffAt,
          batch_limit AS batchLimit,
          selected_count AS selectedCount,
          deleted_count AS deletedCount,
          completed_at AS completedAt
        FROM retention_cleanup_runs
        WHERE workspace_id = ${workspaceId}
        ORDER BY completed_at, run_id`.pipe(mapPersistenceOperation("retention.list-runs"))
      return yield* decodeRows(RetentionCleanupRun, rows)
    }),
    recordSandboxReconciliation: Effect.fn("RetentionRepository.recordSandboxReconciliation")(function*(
      workspaceId: WorkspaceId,
      removedCount: number
    ) {
      if (!Number.isSafeInteger(removedCount) || removedCount < 0) {
        return yield* new PersistenceOperationError({
          operation: "retention.sandbox-artifact-count"
        })
      }
      const settings = yield* workspaceSettings.get(workspaceId).pipe(
        Effect.mapError(
          () =>
            new PersistenceOperationError({
              operation: "retention.workspace-settings"
            })
        )
      )
      const completedAt = Schema.encodeSync(UtcTimestamp)(yield* DateTime.now)
      const cutoffAt = Schema.encodeSync(UtcTimestamp)(
        DateTime.subtract(DateTime.makeUnsafe(completedAt), {
          days: settings.settings.retention.sandboxArtifactDays
        })
      )
      return yield* database
        .transaction(
          Effect.gen(function*() {
            const runs = new Array<RetentionCleanupRun>()
            let remaining = removedCount
            do {
              const chunk = Math.min(remaining, SANDBOX_ARTIFACT_BATCH_LIMIT)
              runs.push(
                yield* recordRun(
                  workspaceId,
                  "sandbox-artifact",
                  settings.policyRevision,
                  cutoffAt,
                  SANDBOX_ARTIFACT_BATCH_LIMIT,
                  chunk,
                  chunk,
                  completedAt
                )
              )
              remaining -= chunk
            } while (remaining > 0)
            return runs
          })
        )
        .pipe(mapPersistenceOperation("retention.sandbox-artifact"))
    }),
    sweepWorkspace: Effect.fn("RetentionRepository.sweepWorkspace")(function*(workspaceId: WorkspaceId) {
      const settings = yield* workspaceSettings
        .get(workspaceId)
        .pipe(Effect.mapError(() => new PersistenceOperationError({ operation: "retention.workspace-settings" })))
      const completedAt = Schema.encodeSync(UtcTimestamp)(yield* DateTime.now)
      const now = DateTime.makeUnsafe(completedAt)
      const auditCutoff = Schema.encodeSync(UtcTimestamp)(
        DateTime.subtract(now, { days: settings.settings.retention.auditDays })
      )
      const contentCutoff = Schema.encodeSync(UtcTimestamp)(
        DateTime.subtract(now, { days: settings.settings.retention.contentDays })
      )
      const agentCutoff = Schema.encodeSync(UtcTimestamp)(
        DateTime.subtract(now, { days: settings.settings.retention.agentActivityDays })
      )
      const runs = new Array<RetentionCleanupRun>()
      runs.push(yield* sweepAuditReplay(workspaceId, settings.policyRevision, auditCutoff, completedAt))
      runs.push(yield* sweepReproducibleContent(workspaceId, settings.policyRevision, contentCutoff, completedAt))
      runs.push(yield* sweepEvidence(workspaceId, settings.policyRevision, completedAt))
      runs.push(yield* sweepAgentContent(workspaceId, settings.policyRevision, agentCutoff, completedAt))
      return runs
    })
  }
})

/** Effect service for policy-driven cleanup and immutable cleanup attribution. */
export class RetentionRepository extends Context.Service<RetentionRepository, RetentionRepositoryService>()(
  "@knpkv/control-center/server/persistence/RetentionRepository"
) {
  static readonly layer = Layer.effect(RetentionRepository, makeRetentionRepository)
}
