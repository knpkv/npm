import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import type { Success } from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import { AuthorizedShareGrant } from "../../../domain/authorizedShare.js"
import { EntityId, PersonId, SessionId, ShareId, WorkspaceId } from "../../../domain/identifiers.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { Database } from "../Database.js"
import { RecordAlreadyExistsError, RecordNotFoundError } from "../errors.js"
import { mapAlreadyExists, mapPersistenceOperation } from "./internal.js"

const RECORD_KIND = "authorized-share"

/** Raised when authorized-share persistence input fails boundary decoding. */
export class AuthorizedShareInputError extends Schema.TaggedErrorClass<AuthorizedShareInputError>()(
  "AuthorizedShareInputError",
  { operation: Schema.Literals(["create", "get", "revoke"]) }
) {}

/** Immutable owner-authored exact-entity share grant. */
export const CreateAuthorizedShareInput = Schema.Struct({
  workspaceId: WorkspaceId,
  shareId: ShareId,
  entityId: EntityId,
  granteePersonId: PersonId,
  createdByPersonId: PersonId,
  createdBySessionId: SessionId,
  createdAt: UtcTimestamp,
  expiresAt: UtcTimestamp
})

/** Decoded authorized-share creation command. */
export type CreateAuthorizedShareInput = typeof CreateAuthorizedShareInput.Type

/** Workspace-scoped authorized-share lookup. */
export const ReadAuthorizedShareInput = Schema.Struct({
  workspaceId: WorkspaceId,
  shareId: ShareId
})

/** Immutable owner-authored share revocation. */
export const RevokeAuthorizedShareInput = Schema.Struct({
  workspaceId: WorkspaceId,
  shareId: ShareId,
  revokedByPersonId: PersonId,
  revokedBySessionId: SessionId,
  revokedAt: UtcTimestamp
})

/** Decoded authorized-share revocation command. */
export type RevokeAuthorizedShareInput = typeof RevokeAuthorizedShareInput.Type

const AuthorizedShareRow = Schema.Struct({
  workspaceId: WorkspaceId,
  shareId: ShareId,
  entityId: EntityId,
  granteePersonId: PersonId,
  createdByPersonId: PersonId,
  createdBySessionId: SessionId,
  createdAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  revokedAt: Schema.NullOr(UtcTimestamp)
})

type AuthorizedShareRow = typeof AuthorizedShareRow.Type

const decodeInput = <SchemaType extends Schema.Top>(
  schema: SchemaType,
  operation: AuthorizedShareInputError["operation"],
  input: unknown
): Effect.Effect<SchemaType["Type"], AuthorizedShareInputError, SchemaType["DecodingServices"]> =>
  Schema.decodeUnknownEffect(Schema.toType(schema))(input).pipe(
    Effect.mapError(() => new AuthorizedShareInputError({ operation }))
  )

const grantFromRow = (row: AuthorizedShareRow): Effect.Effect<AuthorizedShareGrant, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(Schema.toType(AuthorizedShareGrant))({
    workspaceId: row.workspaceId,
    shareId: row.shareId,
    target: { _tag: "entity", entityId: row.entityId },
    granteePersonId: row.granteePersonId,
    createdByPersonId: row.createdByPersonId,
    createdBySessionId: row.createdBySessionId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt
  })

const sameCreateIntent = (
  existing: AuthorizedShareGrant,
  requested: CreateAuthorizedShareInput
): boolean =>
  existing.workspaceId === requested.workspaceId &&
  existing.shareId === requested.shareId &&
  existing.target.entityId === requested.entityId &&
  existing.granteePersonId === requested.granteePersonId &&
  existing.createdByPersonId === requested.createdByPersonId &&
  existing.createdBySessionId === requested.createdBySessionId &&
  DateTime.Order(existing.expiresAt, requested.expiresAt) === 0

const makeAuthorizedShareRepository = Effect.gen(function*() {
  const database = yield* Database
  const sql = database.sql

  const findRows = Effect.fn("AuthorizedShareRepository.findRows")(function*(
    workspaceId: WorkspaceId,
    shareId: ShareId
  ) {
    const rows = yield* sql`SELECT
      grant_record.workspace_id AS workspaceId,
      grant_record.share_id AS shareId,
      grant_record.entity_id AS entityId,
      grant_record.grantee_person_id AS granteePersonId,
      grant_record.created_by_person_id AS createdByPersonId,
      grant_record.created_by_session_id AS createdBySessionId,
      grant_record.created_at AS createdAt,
      grant_record.expires_at AS expiresAt,
      revocation.revoked_at AS revokedAt
    FROM authorized_share_grants grant_record
    LEFT JOIN authorized_share_revocations revocation
      ON revocation.workspace_id = grant_record.workspace_id
      AND revocation.share_id = grant_record.share_id
    WHERE grant_record.workspace_id = ${workspaceId}
      AND grant_record.share_id = ${shareId}`
    return yield* Schema.decodeUnknownEffect(Schema.Array(AuthorizedShareRow))(rows)
  })

  const readGrant = Effect.fn("AuthorizedShareRepository.readGrant")(function*(request: {
    readonly workspaceId: WorkspaceId
    readonly shareId: ShareId
  }) {
    const rows = yield* findRows(request.workspaceId, request.shareId)
    const row = rows[0]
    if (row === undefined) {
      return yield* new RecordNotFoundError({
        workspaceId: request.workspaceId,
        recordKind: RECORD_KIND,
        recordKey: request.shareId
      })
    }
    return yield* grantFromRow(row)
  })

  const read = Effect.fn("AuthorizedShareRepository.read")(function*(input: unknown) {
    const request = yield* decodeInput(ReadAuthorizedShareInput, "get", input)
    return yield* readGrant(request)
  }, mapPersistenceOperation("authorized-share.get"))

  return {
    create: Effect.fn("AuthorizedShareRepository.create")(function*(input: unknown) {
      const request = yield* decodeInput(CreateAuthorizedShareInput, "create", input)
      return yield* database.transaction(Effect.gen(function*() {
        const existingRow = (yield* findRows(request.workspaceId, request.shareId))[0]
        if (existingRow !== undefined) {
          const existing = yield* grantFromRow(existingRow)
          if (sameCreateIntent(existing, request)) return existing
          return yield* new RecordAlreadyExistsError({
            workspaceId: request.workspaceId,
            recordKind: RECORD_KIND,
            recordKey: request.shareId
          })
        }
        yield* sql`INSERT INTO authorized_share_grants (
          workspace_id, share_id, schema_version, entity_id, grantee_person_id,
          created_by_person_id, created_by_session_id, expires_at, created_at
        ) VALUES (
          ${request.workspaceId}, ${request.shareId}, 1, ${request.entityId}, ${request.granteePersonId},
          ${request.createdByPersonId}, ${request.createdBySessionId},
          ${Schema.encodeSync(UtcTimestamp)(request.expiresAt)},
          ${Schema.encodeSync(UtcTimestamp)(request.createdAt)}
        )`.pipe(mapAlreadyExists({
          workspaceId: request.workspaceId,
          recordKind: RECORD_KIND,
          recordKey: request.shareId
        }))
        return yield* readGrant(request)
      }))
    }, mapPersistenceOperation("authorized-share.create")),
    get: read,
    revoke: Effect.fn("AuthorizedShareRepository.revoke")(function*(input: unknown) {
      const request = yield* decodeInput(RevokeAuthorizedShareInput, "revoke", input)
      return yield* database.transaction(
        Effect.gen(function*() {
          const existing = yield* readGrant(request)
          if (existing.revokedAt !== null) return existing
          yield* sql`INSERT INTO authorized_share_revocations (
            workspace_id, share_id, revoked_by_person_id, revoked_by_session_id, revoked_at
          ) VALUES (
            ${request.workspaceId}, ${request.shareId}, ${request.revokedByPersonId},
            ${request.revokedBySessionId}, ${Schema.encodeSync(UtcTimestamp)(request.revokedAt)}
          )`
          return yield* read(request)
        })
      )
    }, mapPersistenceOperation("authorized-share.revoke"))
  }
})

/** Durable exact-scope authorized-share repository service. */
export interface AuthorizedShareRepositoryService extends Success<typeof makeAuthorizedShareRepository> {}

/** Private authorized-share SQL repository. */
export class AuthorizedShareRepository extends Context.Service<
  AuthorizedShareRepository,
  AuthorizedShareRepositoryService
>()("@knpkv/control-center/server/persistence/AuthorizedShareRepository") {
  static readonly layer = Layer.effect(AuthorizedShareRepository, makeAuthorizedShareRepository)
}
