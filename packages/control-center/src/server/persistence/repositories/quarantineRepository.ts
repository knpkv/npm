import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type { Success } from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"

import { WorkspaceId } from "../../../domain/identifiers.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { Database } from "../Database.js"
import { QuarantineWriteError } from "../errors.js"
import { mapPersistenceOperation } from "./internal.js"
import { ContentBlobDigest, QuarantinedRecordMetadata, QuarantineReasonCode, QuarantineRecordKind } from "./models.js"

const QuarantineIdentity = Schema.Struct({
  workspaceId: WorkspaceId,
  recordKind: QuarantineRecordKind,
  recordKey: QuarantinedRecordMetadata.fields.recordKey,
  schemaVersion: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  payloadDigest: ContentBlobDigest,
  diagnosticCode: QuarantineReasonCode
})

const RecordMalformedRequest = Schema.Struct({
  ...QuarantineIdentity.fields,
  diagnosticSummary: QuarantinedRecordMetadata.fields.diagnosticSummary,
  observedAt: UtcTimestamp
})

const makeQuarantineRepository = Effect.gen(function*() {
  const database = yield* Database
  const sql = database.sql

  const upsert = SqlSchema.void({
    Request: RecordMalformedRequest,
    execute: ({
      diagnosticCode,
      diagnosticSummary,
      observedAt,
      payloadDigest,
      recordKey,
      recordKind,
      schemaVersion,
      workspaceId
    }) =>
      sql`INSERT INTO quarantined_records (
            workspace_id, record_kind, record_key, schema_version, payload_digest,
            diagnostic_code, diagnostic_summary, first_observed_at,
            last_observed_at, occurrence_count
          ) VALUES (
            ${workspaceId}, ${recordKind}, ${recordKey}, ${schemaVersion}, ${payloadDigest},
            ${diagnosticCode}, ${diagnosticSummary}, ${observedAt}, ${observedAt}, 1
          )
          ON CONFLICT (
            workspace_id, record_kind, record_key, schema_version,
            payload_digest, diagnostic_code
          ) DO UPDATE SET
            diagnostic_summary = excluded.diagnostic_summary,
            first_observed_at = MIN(
              quarantined_records.first_observed_at,
              excluded.first_observed_at
            ),
            last_observed_at = MAX(
              quarantined_records.last_observed_at,
              excluded.last_observed_at
            ),
            occurrence_count = quarantined_records.occurrence_count + 1`
  })

  const listRows = SqlSchema.findAll({
    Request: Schema.Struct({ workspaceId: WorkspaceId }),
    Result: QuarantinedRecordMetadata,
    execute: ({ workspaceId }) =>
      sql`SELECT
            workspace_id AS workspaceId,
            record_kind AS recordKind,
            record_key AS recordKey,
            schema_version AS schemaVersion,
            payload_digest AS payloadDigest,
            diagnostic_code AS diagnosticCode,
            diagnostic_summary AS diagnosticSummary,
            first_observed_at AS firstObservedAt,
            last_observed_at AS lastObservedAt,
            occurrence_count AS occurrenceCount
          FROM quarantined_records
          WHERE workspace_id = ${workspaceId}
          ORDER BY last_observed_at DESC, record_key`
  })

  return {
    list: Effect.fn("QuarantineRepository.list")(function*(workspaceId: WorkspaceId) {
      return yield* listRows({ workspaceId }).pipe(mapPersistenceOperation("quarantine.list"))
    }),
    recordMalformed: Effect.fn("QuarantineRepository.recordMalformed")(function*(
      workspaceId: WorkspaceId,
      input: Omit<typeof RecordMalformedRequest.Type, "workspaceId">
    ) {
      return yield* upsert({ workspaceId, ...input }).pipe(
        Effect.mapError(() =>
          new QuarantineWriteError({
            workspaceId,
            recordKind: input.recordKind,
            recordKey: input.recordKey
          })
        )
      )
    })
  }
})

/** Redacted, bounded malformed-record diagnostics with workspace isolation. */
export interface QuarantineRepositoryService extends Success<typeof makeQuarantineRepository> {}

/** Effect service for persisted-record quarantine metadata. */
export class QuarantineRepository extends Context.Service<
  QuarantineRepository,
  QuarantineRepositoryService
>()("@knpkv/control-center/QuarantineRepository") {
  /** Layer that binds SQL queries to the shared database at construction. */
  static readonly layer = Layer.effect(QuarantineRepository, makeQuarantineRepository)
}
