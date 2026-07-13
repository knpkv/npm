import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import type { Success } from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"

import { WorkspaceId } from "../../../domain/identifiers.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { Database } from "../Database.js"
import { PersistedRecordError, PersistenceOperationError, RecordNotFoundError } from "../errors.js"
import { mapAlreadyExists, mapPersistenceOperation } from "./internal.js"
import { ContentBlobDigest, ContentBlobMetadata, ContentBlobStorageClass } from "./models.js"
import { QuarantineRepository } from "./quarantineRepository.js"

const ContentBlobKey = Schema.Struct({
  workspaceId: WorkspaceId,
  digest: ContentBlobDigest
})

const ContentBlobIdentity = Schema.Struct({ digest: ContentBlobDigest })

const CreateContentBlobMetadataRequest = Schema.Struct({
  ...ContentBlobKey.fields,
  storageClass: ContentBlobStorageClass,
  byteLength: ContentBlobMetadata.fields.byteLength,
  mimeType: ContentBlobMetadata.fields.mimeType,
  createdAt: UtcTimestamp,
  lastVerifiedAt: ContentBlobMetadata.fields.lastVerifiedAt
})

const makeContentBlobMetadataRepository = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const database = yield* Database
  const quarantine = yield* QuarantineRepository
  const sql = database.sql

  const digestPersistedRow = Effect.fn("ContentBlobMetadataRepository.digestPersistedRow")(function*(
    row: unknown
  ) {
    const serialized = yield* Effect.try({
      try: () => JSON.stringify(row),
      catch: () => new PersistenceOperationError({ operation: "content-blob.quarantine-encode" })
    })
    const bytes = yield* Effect.fromResult(
      Encoding.decodeBase64(Encoding.encodeBase64(serialized))
    ).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "content-blob.quarantine-encode" }))
    )
    const digest = yield* cryptoService.digest("SHA-256", bytes).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "content-blob.quarantine-digest" }))
    )
    return ContentBlobDigest.make(Encoding.encodeHex(digest))
  })

  const quarantineMalformed = Effect.fn("ContentBlobMetadataRepository.quarantineMalformed")(function*(
    workspaceId: WorkspaceId,
    row: unknown,
    fallbackKey: ContentBlobDigest | WorkspaceId
  ) {
    const identity = Schema.decodeUnknownResult(ContentBlobIdentity)(row)
    const payloadDigest = yield* digestPersistedRow(row)
    const observedAt = yield* DateTime.now
    yield* quarantine.recordMalformed(workspaceId, {
      recordKind: "content-metadata",
      recordKey: Result.isSuccess(identity) ? identity.success.digest : fallbackKey,
      schemaVersion: 1,
      payloadDigest,
      diagnosticCode: "content-metadata-schema-invalid",
      diagnosticSummary: "Stored content metadata failed schema validation.",
      observedAt
    })
  })

  const selectColumns = sql`SELECT
    workspace_id AS workspaceId,
    digest,
    storage_class AS storageClass,
    byte_length AS byteLength,
    mime_type AS mimeType,
    created_at AS createdAt,
    last_verified_at AS lastVerifiedAt
  FROM content_blobs`

  const findRows = ({ digest, workspaceId }: typeof ContentBlobKey.Type) =>
    sql<Record<string, unknown>>`${selectColumns}
      WHERE workspace_id = ${workspaceId}
        AND digest = ${digest}`

  const listRows = (workspaceId: WorkspaceId) =>
    sql<Record<string, unknown>>`${selectColumns}
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC, digest`

  const insert = SqlSchema.void({
    Request: CreateContentBlobMetadataRequest,
    execute: ({ byteLength, createdAt, digest, lastVerifiedAt, mimeType, storageClass, workspaceId }) =>
      sql`INSERT INTO content_blobs (
            workspace_id, digest, storage_class, byte_length, mime_type,
            created_at, last_verified_at
          ) VALUES (
            ${workspaceId}, ${digest}, ${storageClass}, ${byteLength}, ${mimeType},
            ${createdAt}, ${lastVerifiedAt}
          )`
  })

  const markVerified = SqlSchema.void({
    Request: Schema.Struct({ ...ContentBlobKey.fields, verifiedAt: UtcTimestamp }),
    execute: ({ digest, verifiedAt, workspaceId }) =>
      sql`UPDATE content_blobs
          SET last_verified_at = CASE
            WHEN last_verified_at IS NULL OR last_verified_at < ${verifiedAt}
              THEN ${verifiedAt}
            ELSE last_verified_at
          END
          WHERE workspace_id = ${workspaceId}
            AND digest = ${digest}`
  })

  const get = Effect.fn("ContentBlobMetadataRepository.get")(function*(
    workspaceId: WorkspaceId,
    digest: ContentBlobDigest
  ) {
    const rows = yield* findRows({ workspaceId, digest }).pipe(
      mapPersistenceOperation("content-blob.get")
    )
    if (rows.length === 0) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "content-blob",
        recordKey: digest
      })
    }
    const decoded = Schema.decodeUnknownResult(ContentBlobMetadata)(rows[0])
    if (Result.isSuccess(decoded)) return decoded.success
    yield* quarantineMalformed(workspaceId, rows[0], digest)
    return yield* new PersistedRecordError({
      workspaceId,
      recordKind: "content-metadata",
      recordKey: digest,
      diagnosticCode: "content-metadata-schema-invalid"
    })
  })

  return {
    create: Effect.fn("ContentBlobMetadataRepository.create")(function*(
      workspaceId: WorkspaceId,
      input: Omit<typeof CreateContentBlobMetadataRequest.Type, "workspaceId">
    ) {
      yield* insert({ workspaceId, ...input }).pipe(
        mapAlreadyExists({ workspaceId, recordKind: "content-blob", recordKey: input.digest }),
        mapPersistenceOperation("content-blob.create")
      )
      return yield* get(workspaceId, input.digest)
    }),
    get,
    list: Effect.fn("ContentBlobMetadataRepository.list")(function*(workspaceId: WorkspaceId) {
      const rows = yield* listRows(workspaceId).pipe(mapPersistenceOperation("content-blob.list"))
      const metadata: Array<ContentBlobMetadata> = []
      for (const row of rows) {
        const decoded = Schema.decodeUnknownResult(ContentBlobMetadata)(row)
        if (Result.isSuccess(decoded)) {
          metadata.push(decoded.success)
        } else {
          yield* quarantineMalformed(workspaceId, row, workspaceId)
        }
      }
      return metadata
    }),
    markVerified: Effect.fn("ContentBlobMetadataRepository.markVerified")(function*(
      workspaceId: WorkspaceId,
      digest: ContentBlobDigest,
      verifiedAt: UtcTimestamp
    ) {
      yield* markVerified({ workspaceId, digest, verifiedAt }).pipe(
        mapPersistenceOperation("content-blob.verify")
      )
      return yield* get(workspaceId, digest)
    })
  }
})

/** Workspace-isolated metadata for content addressed bytes stored elsewhere. */
export interface ContentBlobMetadataRepositoryService extends
  Success<
    typeof makeContentBlobMetadataRepository
  >
{}

/** Effect service for content-blob metadata. */
export class ContentBlobMetadataRepository extends Context.Service<
  ContentBlobMetadataRepository,
  ContentBlobMetadataRepositoryService
>()("@knpkv/control-center/ContentBlobMetadataRepository") {
  /** Layer that binds SQL queries to the shared database at construction. */
  static readonly layer = Layer.effect(ContentBlobMetadataRepository, makeContentBlobMetadataRepository)
}
