import type { BrowserPairingError } from "@knpkv/browser-pairing"
import {
  CredentialDigest,
  CsrfToken as BrowserCsrfToken,
  hashCredential as hashBrowserCredential,
  verifyCredentialDigest
} from "@knpkv/browser-pairing"
import { Effect, Redacted, Schema } from "effect"

import type { BindConfig } from "./BindConfig.js"

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

export const RequestAccess = Schema.Literals(["public-pair", "authenticated-read"])

export type RequestAccess = typeof RequestAccess.Type

export const InsecureLanCapability = Schema.Literals([
  "release-read",
  "release-action",
  "release-agent",
  "session-self-read",
  "provider-configuration",
  "policy-administration",
  "pairing-administration",
  "session-administration",
  "secret-inspection"
])

export type InsecureLanCapability = typeof InsecureLanCapability.Type

export const CsrfDigest = CredentialDigest

export type CsrfDigest = typeof CsrfDigest.Type

export const CsrfToken = BrowserCsrfToken

export type CsrfToken = typeof CsrfToken.Type

const RequestContract = Schema.Struct({
  method: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(16)),
  host: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(260)),
  origin: Schema.Union([Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(2_048)), Schema.Null]),
  csrfToken: Schema.Union([Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512)), Schema.Null]),
  forwardedHost: Schema.Union([Schema.String.check(Schema.isMaxLength(260)), Schema.Null]),
  forwardedProto: Schema.Union([Schema.String.check(Schema.isMaxLength(16)), Schema.Null]),
  remoteAddress: Schema.Union([Schema.String.check(Schema.isMaxLength(64)), Schema.Null])
})

export type RequestContract = typeof RequestContract.Type

export interface SessionCookiePolicy {
  readonly name: "cc_session"
  readonly httpOnly: true
  readonly sameSite: "strict"
  readonly path: "/"
  readonly secure: boolean
}

/** A capability-bearing authenticated read checked by centralized middleware. */
export interface AuthenticatedReadAuthorization {
  readonly config: BindConfig
  readonly request: unknown
  readonly capability: InsecureLanCapability
}

/** A capability-bearing mutation whose CSRF proof is verified at the authorization boundary. */
export interface AuthenticatedMutationAuthorization {
  readonly config: BindConfig
  readonly request: unknown
  readonly capability: InsecureLanCapability
}

/** A request failed the same-origin/session transport policy. */
export class RequestSecurityError extends Schema.TaggedError<RequestSecurityError>()("RequestSecurityError", {
  reason: Schema.Literals([
    "invalid-request",
    "host-rejected",
    "origin-required",
    "origin-rejected",
    "csrf-required",
    "csrf-rejected",
    "method-mismatch",
    "proxy-rejected",
    "insecure-lan-capability-rejected"
  ])
}) {}

const lowerHost = (value: string): string => value.toLowerCase()

/** Forwarded headers are authoritative only from an exact trusted proxy address. */
export const effectiveRequestAuthority = (
  config: BindConfig,
  request: RequestContract
) => {
  const trusted = request.remoteAddress !== null &&
    config.trustedProxyAddresses.some((address) => address === request.remoteAddress)
  const host = trusted && request.forwardedHost !== null ? request.forwardedHost : request.host
  const protocol = trusted && request.forwardedProto === "https" ? "https" : config.cookieSecure ? "https" : "http"
  return { host: lowerHost(host), protocol }
}

const authorizeRequestAuthority = Effect.fn("RequestSecurity.authorizeAuthority")(function*<UnparsedInput>(
  config: BindConfig,
  input: UnparsedInput
) {
  const request = yield* Schema.decodeUnknownEffect(RequestContract)(input).pipe(
    Effect.mapError(() => new RequestSecurityError({ reason: "invalid-request" }))
  )
  const trustedProxy = request.remoteAddress !== null &&
    config.trustedProxyAddresses.some((address) => address === request.remoteAddress)
  if (config.transportPolicy === "trusted-tls-proxy" && (!trustedProxy || request.forwardedProto !== "https")) {
    return yield* new RequestSecurityError({ reason: "proxy-rejected" })
  }
  const authority = effectiveRequestAuthority(config, request)
  if (!config.allowedHosts.some((host) => host === authority.host)) {
    return yield* new RequestSecurityError({ reason: "host-rejected" })
  }

  return request
})

const authorizeMutationOrigin = Effect.fn("RequestSecurity.authorizeMutationOrigin")(function*(
  config: BindConfig,
  request: RequestContract
) {
  if (SAFE_METHODS.has(request.method.toUpperCase())) {
    return yield* new RequestSecurityError({ reason: "method-mismatch" })
  }
  if (request.origin === null) return yield* new RequestSecurityError({ reason: "origin-required" })
  if (!config.allowedOrigins.some((origin) => origin === request.origin)) {
    return yield* new RequestSecurityError({ reason: "origin-rejected" })
  }
})

/** Authorize a public pairing mutation or an authenticated safe read. */
export const authorizeRequest = Effect.fn("RequestSecurity.authorize")(function*<UnparsedInput>(
  config: BindConfig,
  input: UnparsedInput,
  access: RequestAccess
) {
  const request = yield* authorizeRequestAuthority(config, input)

  const method = request.method.toUpperCase()
  const mutation = !SAFE_METHODS.has(method)
  if (access === "authenticated-read" && mutation) {
    return yield* new RequestSecurityError({ reason: "method-mismatch" })
  }
  if (
    access === "authenticated-read" &&
    request.origin !== null &&
    !config.allowedOrigins.some((origin) => origin === request.origin)
  ) {
    return yield* new RequestSecurityError({ reason: "origin-rejected" })
  }
  if (access === "public-pair" && method !== "POST") {
    return yield* new RequestSecurityError({ reason: "method-mismatch" })
  }
  if (mutation) {
    yield* authorizeMutationOrigin(config, request)
  }
  if (access === "public-pair") {
    yield* authorizeInsecureLanCapability(config, "pairing-administration")
  }
  return undefined
})

/** Hash a CSRF token for storage beside its session without retaining the token. */
export const hashCsrfToken = Effect.fn("RequestSecurity.hashCsrf")(function*(token: string) {
  return yield* hashBrowserCredential(Redacted.make(token)).pipe(
    Effect.mapError((_error: BrowserPairingError) => new RequestSecurityError({ reason: "csrf-rejected" }))
  )
})

/** Verify a supplied CSRF token against the fixed-size stored digest. */
export const verifyCsrfToken = Effect.fn("RequestSecurity.verifyCsrf")(function*(
  token: string | null,
  expectedDigest: string
) {
  if (token === null) return yield* new RequestSecurityError({ reason: "csrf-required" })
  yield* verifyCredentialDigest(Redacted.make(token), expectedDigest).pipe(
    Effect.mapError((_error: BrowserPairingError) => new RequestSecurityError({ reason: "csrf-rejected" }))
  )
})

/** Insecure HTTP LAN clients cannot perform administration or inspect secrets. */
export const authorizeInsecureLanCapability = (
  config: BindConfig,
  capability: InsecureLanCapability
): Effect.Effect<void, RequestSecurityError> => {
  if (config.transportPolicy !== "insecure-lan") return Effect.void
  if (
    capability === "release-read" ||
    capability === "release-action" ||
    capability === "session-self-read"
  ) {
    return Effect.void
  }
  return Effect.fail(new RequestSecurityError({ reason: "insecure-lan-capability-rejected" }))
}

/** Authorize a safe authenticated read together with its deployment capability policy. */
export const authorizeAuthenticatedRead = Effect.fn("RequestSecurity.authorizeAuthenticatedRead")(function*(
  authorization: AuthenticatedReadAuthorization
) {
  yield* authorizeRequest(authorization.config, authorization.request, "authenticated-read")
  yield* authorizeInsecureLanCapability(authorization.config, authorization.capability)
})

/**
 * Authorize a read-only operation transported as POST so a bounded structured
 * selector can stay in the request body without acquiring mutation authority.
 */
export const authorizeAuthenticatedReadPost = Effect.fn("RequestSecurity.authorizeAuthenticatedReadPost")(function*(
  authorization: AuthenticatedReadAuthorization
) {
  const request = yield* authorizeRequestAuthority(authorization.config, authorization.request)
  if (request.method.toUpperCase() !== "POST") {
    return yield* new RequestSecurityError({ reason: "method-mismatch" })
  }
  yield* authorizeMutationOrigin(authorization.config, request)
  yield* authorizeInsecureLanCapability(authorization.config, authorization.capability)
})

/**
 * Authorize transport, exact Origin, session-owned CSRF verification, and
 * capability as one mutation guard. The required verifier is normally
 * `Auth.authorizeMutation` closed over the request's session token.
 */
export const authorizeAuthenticatedMutation = Effect.fn("RequestSecurity.authorizeAuthenticatedMutation")(function*<
  A,
  E,
  R
>(
  authorization: AuthenticatedMutationAuthorization,
  verifySessionCsrf: (csrfToken: Redacted.Redacted<CsrfToken>) => Effect.Effect<A, E, R>
) {
  const request = yield* authorizeRequestAuthority(authorization.config, authorization.request)
  yield* authorizeMutationOrigin(authorization.config, request)
  if (request.csrfToken === null) return yield* new RequestSecurityError({ reason: "csrf-required" })
  yield* authorizeInsecureLanCapability(authorization.config, authorization.capability)
  return yield* verifySessionCsrf(Redacted.make(BrowserCsrfToken.make(request.csrfToken)))
})

/** Cookie attributes for the opaque session token; the token itself is never represented here. */
export const sessionCookiePolicy = (config: BindConfig): SessionCookiePolicy => ({
  name: "cc_session",
  httpOnly: true,
  sameSite: "strict",
  path: "/",
  secure: config.cookieSecure
})
