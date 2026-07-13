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

import { EntityId, WorkspaceId } from "../../../domain/identifiers.js"
import {
  NormalizationSchemaVersion,
  ProviderId,
  Revision,
  SourceRevision,
  SourceUrl,
  VendorImmutableId
} from "../../../domain/sourceRevision.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { Database } from "../Database.js"
import {
  PersistedRecordError,
  PersistenceOperationError,
  RecordNotFoundError,
  SourceIdentityMismatchError
} from "../errors.js"
import {
  mapAlreadyExists,
  mapPersistenceOperation,
  readChanges,
  resolveCasFailure,
  revisionLookup
} from "./internal.js"
import { ContentBlobDigest, EntityKind, EntityRecord, RecordRevision } from "./models.js"
import { QuarantineRepository } from "./quarantineRepository.js"

const EntityKey = Schema.Struct({ workspaceId: WorkspaceId, entityId: EntityId })

const EntityRow = Schema.Struct({
  workspaceId: WorkspaceId,
  entityId: EntityId,
  entityType: EntityKind,
  recordRevision: RecordRevision,
  pluginConnectionId: SourceRevision.fields.pluginConnectionId,
  providerId: ProviderId,
  vendorImmutableId: VendorImmutableId,
  sourceRevision: Revision,
  normalizationSchemaVersion: NormalizationSchemaVersion,
  sourceUrl: Schema.Union([SourceUrl, Schema.Null]),
  firstObservedAt: UtcTimestamp,
  lastObservedAt: UtcTimestamp,
  synchronizedAt: UtcTimestamp,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp
})

const CreateEntityRequest = Schema.Struct({
  ...EntityKey.fields,
  entityType: EntityKind,
  sourceRevision: SourceRevision,
  createdAt: UtcTimestamp
})

const UpdateEntityRequest = Schema.Struct({
  ...EntityKey.fields,
  sourceRevision: SourceRevision,
  expectedRevision: RecordRevision,
  updatedAt: UtcTimestamp
})

const EntityIdentityHead = Schema.Struct({
  entityId: EntityId,
  recordRevision: RecordRevision,
  pluginConnectionId: SourceRevision.fields.pluginConnectionId,
  providerId: ProviderId,
  vendorImmutableId: VendorImmutableId
})

const EntityRevisionIdentity = Schema.Struct({
  entityId: EntityId,
  recordRevision: RecordRevision
})

const decodeEntityRecord = Effect.fn("EntityRepository.decodeRecord")(function*(row: typeof EntityRow.Type) {
  return yield* Schema.decodeUnknownEffect(Schema.toType(EntityRecord))({
    workspaceId: row.workspaceId,
    entityId: row.entityId,
    entityType: row.entityType,
    revision: row.recordRevision,
    sourceRevision: {
      pluginConnectionId: row.pluginConnectionId,
      providerId: row.providerId,
      vendorImmutableId: row.vendorImmutableId,
      revision: row.sourceRevision,
      normalizationSchemaVersion: row.normalizationSchemaVersion,
      sourceUrl: row.sourceUrl,
      firstObservedAt: row.firstObservedAt,
      lastObservedAt: row.lastObservedAt,
      synchronizedAt: row.synchronizedAt
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  })
})

const makeEntityRepository = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const database = yield* Database
  const quarantine = yield* QuarantineRepository
  const sql = database.sql

  const digestPersistedRow = Effect.fn("EntityRepository.digestPersistedRow")(function*(row: unknown) {
    const serialized = yield* Effect.try({
      try: () => JSON.stringify(row),
      catch: () => new PersistenceOperationError({ operation: "entity.quarantine-encode" })
    })
    const bytes = yield* Effect.fromResult(
      Encoding.decodeBase64(Encoding.encodeBase64(serialized))
    ).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "entity.quarantine-encode" }))
    )
    const digest = yield* cryptoService.digest("SHA-256", bytes).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "entity.quarantine-digest" }))
    )
    return ContentBlobDigest.make(Encoding.encodeHex(digest))
  })

  const quarantineMalformedRevision = Effect.fn("EntityRepository.quarantineMalformed")(function*(
    workspaceId: WorkspaceId,
    row: unknown,
    identity: Result.Result<typeof EntityRevisionIdentity.Type, Schema.SchemaError>
  ) {
    const payloadDigest = yield* digestPersistedRow(row)
    const observedAt = yield* DateTime.now
    yield* quarantine.recordMalformed(workspaceId, {
      recordKind: "entity-revision",
      recordKey: Result.isSuccess(identity)
        ? `${identity.success.entityId}:${identity.success.recordRevision}`
        : workspaceId,
      schemaVersion: 1,
      payloadDigest,
      diagnosticCode: "entity-revision-schema-invalid",
      diagnosticSummary: "Stored entity revision failed schema validation.",
      observedAt
    })
  })

  const selectColumns = sql`SELECT
    entity.workspace_id AS workspaceId,
    entity.entity_id AS entityId,
    entity.entity_type AS entityType,
    revision.revision AS recordRevision,
    entity.plugin_connection_id AS pluginConnectionId,
    entity.provider_id AS providerId,
    entity.vendor_immutable_id AS vendorImmutableId,
    revision.source_revision AS sourceRevision,
    revision.normalization_schema_version AS normalizationSchemaVersion,
    revision.source_url AS sourceUrl,
    revision.first_observed_at AS firstObservedAt,
    revision.last_observed_at AS lastObservedAt,
    revision.synchronized_at AS synchronizedAt,
    entity.created_at AS createdAt,
    entity.updated_at AS updatedAt
  FROM entities AS entity
  INNER JOIN entity_revisions AS revision
    ON revision.workspace_id = entity.workspace_id
   AND revision.entity_id = entity.entity_id
   AND revision.revision <= entity.current_revision`

  const findRows = ({ entityId, workspaceId }: typeof EntityKey.Type) =>
    sql<Record<string, unknown>>`${selectColumns}
      WHERE entity.workspace_id = ${workspaceId}
        AND entity.entity_id = ${entityId}
      ORDER BY revision.revision DESC`

  const listRows = (workspaceId: WorkspaceId) =>
    sql<Record<string, unknown>>`${selectColumns}
      WHERE entity.workspace_id = ${workspaceId}
      ORDER BY entity.updated_at DESC, entity.entity_id, revision.revision DESC`

  const get = Effect.fn("EntityRepository.get")(function*(
    workspaceId: WorkspaceId,
    entityId: EntityId
  ) {
    const headRows = yield* findIdentityHeadRows({ workspaceId, entityId }).pipe(
      mapPersistenceOperation("entity.get-head")
    )
    if (headRows.length === 0) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "entity",
        recordKey: entityId
      })
    }
    const head = Schema.decodeUnknownResult(EntityIdentityHead)(headRows[0])
    if (Result.isFailure(head)) {
      yield* quarantineMalformedRevision(
        workspaceId,
        headRows[0],
        Schema.decodeUnknownResult(EntityRevisionIdentity)(headRows[0])
      )
      return yield* new PersistedRecordError({
        workspaceId,
        recordKind: "entity",
        recordKey: entityId,
        diagnosticCode: "entity-revision-schema-invalid"
      })
    }
    const rows = yield* findRows({ workspaceId, entityId }).pipe(
      mapPersistenceOperation("entity.get-revisions")
    )
    for (const row of rows) {
      const identity = Schema.decodeUnknownResult(EntityRevisionIdentity)(row)
      const decoded = Schema.decodeUnknownResult(EntityRow)(row)
      if (Result.isFailure(decoded)) {
        yield* quarantineMalformedRevision(workspaceId, row, identity)
        continue
      }
      const record = yield* decodeEntityRecord(decoded.success).pipe(Effect.result)
      if (Result.isFailure(record)) {
        yield* quarantineMalformedRevision(workspaceId, row, identity)
        continue
      }
      return record.success
    }
    return yield* new PersistedRecordError({
      workspaceId,
      recordKind: "entity",
      recordKey: entityId,
      diagnosticCode: "no-valid-entity-revision"
    })
  })

  const insertHead = SqlSchema.void({
    Request: CreateEntityRequest,
    execute: ({ createdAt, entityId, entityType, sourceRevision, workspaceId }) =>
      sql`INSERT INTO entities (
            workspace_id, entity_id, plugin_connection_id, provider_id,
            vendor_immutable_id, entity_type, current_revision, created_at, updated_at
          ) VALUES (
            ${workspaceId}, ${entityId}, ${sourceRevision.pluginConnectionId}, ${sourceRevision.providerId},
            ${sourceRevision.vendorImmutableId}, ${entityType}, 1, ${createdAt}, ${createdAt}
          )`
  })

  const insertRevision = SqlSchema.void({
    Request: Schema.Struct({
      ...EntityKey.fields,
      revision: RecordRevision,
      sourceRevision: SourceRevision,
      createdAt: UtcTimestamp
    }),
    execute: ({ createdAt, entityId, revision, sourceRevision, workspaceId }) =>
      sql`INSERT INTO entity_revisions (
            workspace_id, entity_id, revision, source_revision,
            normalization_schema_version, source_url, first_observed_at,
            last_observed_at, synchronized_at, created_at
          ) VALUES (
            ${workspaceId}, ${entityId}, ${revision}, ${sourceRevision.revision},
            ${sourceRevision.normalizationSchemaVersion}, ${sourceRevision.sourceUrl},
            ${sourceRevision.firstObservedAt}, ${sourceRevision.lastObservedAt},
            ${sourceRevision.synchronizedAt}, ${createdAt}
          )`
  })

  const updateHead = SqlSchema.void({
    Request: UpdateEntityRequest,
    execute: ({ entityId, expectedRevision, updatedAt, workspaceId }) =>
      sql`UPDATE entities
          SET current_revision = current_revision + 1,
              updated_at = ${updatedAt}
          WHERE workspace_id = ${workspaceId}
            AND entity_id = ${entityId}
            AND current_revision = ${expectedRevision}`
  })

  const findIdentityHeadRows = ({ entityId, workspaceId }: typeof EntityKey.Type) =>
    sql<Record<string, unknown>>`SELECT
      entity_id AS entityId,
      current_revision AS recordRevision,
      plugin_connection_id AS pluginConnectionId,
      provider_id AS providerId,
      vendor_immutable_id AS vendorImmutableId
    FROM entities
    WHERE workspace_id = ${workspaceId}
      AND entity_id = ${entityId}`

  const listIdentityHeadRows = (workspaceId: WorkspaceId) =>
    sql<Record<string, unknown>>`SELECT
      entity_id AS entityId,
      current_revision AS recordRevision,
      plugin_connection_id AS pluginConnectionId,
      provider_id AS providerId,
      vendor_immutable_id AS vendorImmutableId
    FROM entities
    WHERE workspace_id = ${workspaceId}
    ORDER BY entity_id`

  return {
    create: Effect.fn("EntityRepository.create")(function*(
      workspaceId: WorkspaceId,
      input: {
        readonly entityId: EntityId
        readonly entityType: EntityKind
        readonly sourceRevision: SourceRevision
        readonly createdAt: UtcTimestamp
      }
    ) {
      yield* database.transaction(
        Effect.gen(function*() {
          yield* insertHead({ workspaceId, ...input })
          yield* insertRevision({
            workspaceId,
            entityId: input.entityId,
            revision: RecordRevision.make(1),
            sourceRevision: input.sourceRevision,
            createdAt: input.createdAt
          })
        }).pipe(
          mapAlreadyExists({ workspaceId, recordKind: "entity", recordKey: input.entityId }),
          mapPersistenceOperation("entity.create")
        )
      )
      return yield* get(workspaceId, input.entityId)
    }),
    get,
    list: Effect.fn("EntityRepository.list")(function*(workspaceId: WorkspaceId) {
      const headRows = yield* listIdentityHeadRows(workspaceId).pipe(
        mapPersistenceOperation("entity.list-heads")
      )
      const validHeads = new Set<EntityId>()
      for (const row of headRows) {
        const head = Schema.decodeUnknownResult(EntityIdentityHead)(row)
        if (Result.isSuccess(head)) {
          validHeads.add(head.success.entityId)
        } else {
          yield* quarantineMalformedRevision(
            workspaceId,
            row,
            Schema.decodeUnknownResult(EntityRevisionIdentity)(row)
          )
        }
      }
      const rows = yield* listRows(workspaceId).pipe(mapPersistenceOperation("entity.list"))
      const records: Array<EntityRecord> = []
      const resolved = new Set<EntityId>()
      for (const row of rows) {
        const identity = Schema.decodeUnknownResult(EntityRevisionIdentity)(row)
        if (Result.isSuccess(identity) && !validHeads.has(identity.success.entityId)) continue
        if (Result.isSuccess(identity) && resolved.has(identity.success.entityId)) continue
        const decoded = Schema.decodeUnknownResult(EntityRow)(row)
        if (Result.isFailure(decoded)) {
          yield* quarantineMalformedRevision(workspaceId, row, identity)
          continue
        }
        const record = yield* decodeEntityRecord(decoded.success).pipe(Effect.result)
        if (Result.isFailure(record)) {
          yield* quarantineMalformedRevision(workspaceId, row, identity)
          continue
        }
        records.push(record.success)
        resolved.add(decoded.success.entityId)
      }
      return records
    }),
    updateSourceRevision: Effect.fn("EntityRepository.updateSourceRevision")(function*(
      workspaceId: WorkspaceId,
      entityId: EntityId,
      input: {
        readonly sourceRevision: SourceRevision
        readonly expectedRevision: RecordRevision
        readonly updatedAt: UtcTimestamp
      }
    ) {
      yield* database.transaction(
        Effect.gen(function*() {
          const identityHeadRows = yield* findIdentityHeadRows({ workspaceId, entityId })
          if (identityHeadRows.length === 0) {
            return yield* new RecordNotFoundError({
              workspaceId,
              recordKind: "entity",
              recordKey: entityId
            })
          }
          const identityHead = Schema.decodeUnknownResult(EntityIdentityHead)(identityHeadRows[0])
          if (Result.isFailure(identityHead)) {
            yield* quarantineMalformedRevision(
              workspaceId,
              identityHeadRows[0],
              Schema.decodeUnknownResult(EntityRevisionIdentity)(identityHeadRows[0])
            )
            return yield* new PersistedRecordError({
              workspaceId,
              recordKind: "entity",
              recordKey: entityId,
              diagnosticCode: "entity-revision-schema-invalid"
            })
          }
          if (
            identityHead.success.pluginConnectionId !== input.sourceRevision.pluginConnectionId ||
            identityHead.success.providerId !== input.sourceRevision.providerId ||
            identityHead.success.vendorImmutableId !== input.sourceRevision.vendorImmutableId
          ) {
            return yield* new SourceIdentityMismatchError({
              workspaceId,
              recordKind: "entity",
              recordKey: entityId
            })
          }
          yield* updateHead({ workspaceId, entityId, ...input })
          const changes = yield* readChanges(sql)
          if (changes === 0) {
            return yield* resolveCasFailure({
              workspaceId,
              recordKind: "entity",
              recordKey: entityId,
              expectedRevision: input.expectedRevision,
              findActualRevision: revisionLookup(() =>
                sql`SELECT current_revision AS revision
                    FROM entities
                    WHERE workspace_id = ${workspaceId}
                      AND entity_id = ${entityId}`
              )
            })
          }
          yield* insertRevision({
            workspaceId,
            entityId,
            revision: RecordRevision.make(input.expectedRevision + 1),
            sourceRevision: input.sourceRevision,
            createdAt: input.updatedAt
          })
        })
      ).pipe(mapPersistenceOperation("entity.update"))
      return yield* get(workspaceId, entityId)
    })
  }
})

/** Workspace-scoped normalized entity persistence with immutable revisions. */
export interface EntityRepositoryService extends Success<typeof makeEntityRepository> {}

/** Effect service for normalized delivery entities. */
export class EntityRepository extends Context.Service<EntityRepository, EntityRepositoryService>()(
  "@knpkv/control-center/EntityRepository"
) {
  /** Layer that binds SQL queries to the shared database at construction. */
  static readonly layer = Layer.effect(EntityRepository, makeEntityRepository)
}
