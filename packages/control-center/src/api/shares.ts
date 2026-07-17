import * as Schema from "effect/Schema"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"

import { EntityId, PersonId, ShareId, WorkspaceId } from "../domain/identifiers.js"
import { UtcTimestamp } from "../domain/utcTimestamp.js"
import { InspectedEntityProjection } from "./deliveryGraph.js"
import {
  ConflictApiError,
  ForbiddenApiError,
  InvalidRequestApiError,
  NotFoundApiError,
  RequestTimedOutApiError,
  ServiceUnavailableApiError,
  UnauthorizedApiError
} from "./errors.js"
import { SessionCookieAuth, SessionMutationAuth } from "./session.js"

/** Owner-authored intent for one exact entity share grant. */
export const CreateAuthorizedShareRequest = Schema.Struct({
  shareId: ShareId,
  entityId: EntityId,
  granteePersonId: PersonId,
  expiresAt: UtcTimestamp
})

/** Decoded authorized-share creation request. */
export type CreateAuthorizedShareRequest = typeof CreateAuthorizedShareRequest.Type

/** Secret-free grant metadata returned to authenticated callers. */
export const AuthorizedShareSummary = Schema.Struct({
  shareId: ShareId,
  entityId: EntityId,
  granteePersonId: PersonId,
  createdAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  revokedAt: Schema.NullOr(UtcTimestamp)
}).annotate({ identifier: "AuthorizedShareSummary" })

/** Decoded secret-free authorized-share metadata. */
export type AuthorizedShareSummary = typeof AuthorizedShareSummary.Type

/** Exact current entity projection resolved without relationships or release context. */
export const AuthorizedShareResolution = Schema.Struct({
  share: AuthorizedShareSummary,
  item: InspectedEntityProjection
}).annotate({ identifier: "AuthorizedShareResolution" })

/** Decoded authorized-share resolution. */
export type AuthorizedShareResolution = typeof AuthorizedShareResolution.Type

const authenticatedErrors = [
  UnauthorizedApiError,
  ForbiddenApiError,
  RequestTimedOutApiError,
  ServiceUnavailableApiError
]

const create = HttpApiEndpoint.post("create", "/", {
  payload: CreateAuthorizedShareRequest,
  success: AuthorizedShareSummary,
  error: [...authenticatedErrors, InvalidRequestApiError, NotFoundApiError, ConflictApiError]
})
  .middleware(SessionCookieAuth)
  .middleware(SessionMutationAuth)

const resolve = HttpApiEndpoint.get("resolve", "/:workspaceId/:shareId", {
  params: Schema.Struct({ workspaceId: WorkspaceId, shareId: ShareId }),
  success: AuthorizedShareResolution,
  error: [...authenticatedErrors, NotFoundApiError]
}).middleware(SessionCookieAuth)

const revoke = HttpApiEndpoint.delete("revoke", "/:workspaceId/:shareId", {
  params: Schema.Struct({ workspaceId: WorkspaceId, shareId: ShareId }),
  success: HttpApiSchema.NoContent,
  error: [...authenticatedErrors, NotFoundApiError]
})
  .middleware(SessionCookieAuth)
  .middleware(SessionMutationAuth)

/** Exact-scope authenticated entity-share contract. */
export class SharesApiGroup extends HttpApiGroup.make("shares")
  .add(create, resolve, revoke)
  .prefix("/api/v1/shares")
{}
