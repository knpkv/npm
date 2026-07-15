import * as Context from "effect/Context"
import * as Schema from "effect/Schema"
import {
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity
} from "effect/unstable/httpapi"

import { Actor, Role } from "../domain/actors.js"
import { SessionId, WorkspaceId } from "../domain/identifiers.js"
import { UtcTimestamp } from "../domain/utcTimestamp.js"
import {
  ConflictApiError,
  ForbiddenApiError,
  InvalidRequestApiError,
  RequestTimedOutApiError,
  ServiceUnavailableApiError,
  UnauthorizedApiError
} from "./errors.js"

const LOWERCASE_SECRET_PATTERN = /^[0-9a-f]{64}$/u

export { SessionId } from "../domain/identifiers.js"

/** Single-use pairing credential accepted only by the public pairing endpoint. */
export const PairingCode = Schema.String.check(
  Schema.isPattern(LOWERCASE_SECRET_PATTERN, { expected: "a lowercase 256-bit pairing credential" })
).pipe(Schema.brand("PairingCode"))

/** Decoded single-use pairing credential. */
export type PairingCode = typeof PairingCode.Type

/** Mutation proof issued separately from the opaque session cookie. */
export const CsrfToken = Schema.String.check(
  Schema.isPattern(LOWERCASE_SECRET_PATTERN, { expected: "a lowercase 256-bit CSRF credential" })
).pipe(Schema.brand("CsrfToken"))

/** Decoded CSRF credential. */
export type CsrfToken = typeof CsrfToken.Type

/** Secret-free metadata describing an authenticated browser session. */
export const SessionSummary = Schema.Struct({
  sessionId: SessionId,
  workspaceId: WorkspaceId,
  actor: Actor,
  permission: Role,
  createdAt: UtcTimestamp,
  lastSeenAt: UtcTimestamp,
  idleExpiresAt: UtcTimestamp,
  absoluteExpiresAt: UtcTimestamp,
  revokedAt: Schema.NullOr(UtcTimestamp)
}).annotate({ identifier: "ApiSessionSummary" })

/** Decoded browser-session metadata. */
export type SessionSummary = typeof SessionSummary.Type

/** Pairing request whose credential is never represented in a URL. */
export const PairSessionRequest = Schema.Struct({ pairingCode: PairingCode })

/** Decoded session-pairing request. */
export type PairSessionRequest = typeof PairSessionRequest.Type

/** Pairing result; the opaque session token is delivered only through the response cookie. */
export const PairSessionResponse = Schema.Struct({
  csrfToken: CsrfToken,
  session: SessionSummary
})

/** Decoded session-pairing response. */
export type PairSessionResponse = typeof PairSessionResponse.Type

/** Authenticated session metadata with a recoverable, session-bound mutation proof. */
export const CurrentSessionResponse = Schema.Struct({
  csrfToken: CsrfToken,
  session: SessionSummary
})

/** Decoded current-session response. */
export type CurrentSessionResponse = typeof CurrentSessionResponse.Type

/** Bounded session-administration response. */
export const SessionListResponse = Schema.Array(SessionSummary).check(
  Schema.makeFilter((sessions) => sessions.length <= 100, { expected: "at most 100 sessions" })
)

/** Decoded bounded session list. */
export type SessionListResponse = typeof SessionListResponse.Type

/** Authenticated session attached to endpoint handlers by cookie middleware. */
export class CurrentSession extends Context.Service<CurrentSession, SessionSummary>()(
  "@knpkv/control-center/api/CurrentSession"
) {}

/** Public middleware identity for the opaque `cc_session` cookie. */
export class SessionCookieAuth extends HttpApiMiddleware.Service<
  SessionCookieAuth,
  {
    provides: CurrentSession
  }
>()("@knpkv/control-center/api/SessionCookieAuth", {
  error: [UnauthorizedApiError, ForbiddenApiError, ServiceUnavailableApiError],
  security: {
    sessionCookie: HttpApiSecurity.apiKey({ in: "cookie", key: "cc_session" })
  }
}) {}

/** Public middleware identity for the separate mutation CSRF header. */
export class SessionMutationAuth extends HttpApiMiddleware.Service<SessionMutationAuth>()(
  "@knpkv/control-center/api/SessionMutationAuth",
  {
    error: [InvalidRequestApiError, ForbiddenApiError],
    security: {
      csrfToken: HttpApiSecurity.apiKey({ in: "header", key: "x-csrf-token" })
    }
  }
) {}

/** Compatibility name emphasizing the CSRF mechanism used by mutation authorization. */
export const MutationCsrf = SessionMutationAuth

const authenticatedErrors = [
  UnauthorizedApiError,
  ForbiddenApiError,
  RequestTimedOutApiError,
  ServiceUnavailableApiError
]

const pair = HttpApiEndpoint.post("pair", "/pair", {
  payload: PairSessionRequest,
  success: PairSessionResponse,
  error: [
    InvalidRequestApiError,
    UnauthorizedApiError,
    ConflictApiError,
    RequestTimedOutApiError,
    ServiceUnavailableApiError
  ]
})

const current = HttpApiEndpoint.get("current", "/current", {
  success: CurrentSessionResponse,
  error: authenticatedErrors
}).middleware(SessionCookieAuth)

const list = HttpApiEndpoint.get("list", "/", {
  success: SessionListResponse,
  error: authenticatedErrors
}).middleware(SessionCookieAuth)

const revoke = HttpApiEndpoint.delete("revoke", "/:sessionId", {
  params: Schema.Struct({ sessionId: SessionId }),
  success: HttpApiSchema.NoContent,
  error: authenticatedErrors
})
  .middleware(SessionCookieAuth)
  .middleware(SessionMutationAuth)

const logout = HttpApiEndpoint.post("logout", "/logout", {
  success: HttpApiSchema.NoContent,
  error: authenticatedErrors
})
  .middleware(SessionCookieAuth)
  .middleware(SessionMutationAuth)

/** Session pairing, inspection, administration, and logout contract. */
export class SessionApiGroup extends HttpApiGroup.make("session")
  .add(pair, current, list, revoke, logout)
  .prefix("/api/v1/session")
{}
