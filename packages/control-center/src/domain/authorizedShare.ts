import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"

import { EntityId, PersonId, SessionId, ShareId, WorkspaceId } from "./identifiers.js"
import { UtcTimestamp } from "./utcTimestamp.js"

/** Exact normalized entity scope granted to one authenticated person. */
export const AuthorizedShareTarget = Schema.TaggedStruct("entity", {
  entityId: EntityId
})

/** Decoded exact authorized-share target. */
export type AuthorizedShareTarget = typeof AuthorizedShareTarget.Type

/** Durable authenticated grant with immutable creation and optional revocation evidence. */
export const AuthorizedShareGrant = Schema.Struct({
  workspaceId: WorkspaceId,
  shareId: ShareId,
  target: AuthorizedShareTarget,
  granteePersonId: PersonId,
  createdByPersonId: PersonId,
  createdBySessionId: SessionId,
  createdAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  revokedAt: Schema.NullOr(UtcTimestamp)
}).check(
  Schema.makeFilter(
    ({ createdAt, expiresAt }) => DateTime.Order(createdAt, expiresAt) < 0,
    { expected: "authorized share expiry after creation" }
  ),
  Schema.makeFilter(
    ({ createdAt, revokedAt }) => revokedAt === null || DateTime.Order(createdAt, revokedAt) <= 0,
    { expected: "authorized share revocation at or after creation" }
  )
)

/** Decoded durable authorized-share grant. */
export type AuthorizedShareGrant = typeof AuthorizedShareGrant.Type
