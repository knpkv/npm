import { Crypto, Effect, Encoding, Redacted, Schema } from "effect"

import type { BindConfig } from "./BindConfig.js"

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

export const RequestAccess = Schema.Literals(["public-pair", "authenticated-read"])

export type RequestAccess = typeof RequestAccess.Type

export const InsecureLanCapability = Schema.Literals([
  "release-read",
  "release-action",
  "release-agent",
  "provider-configuration",
  "policy-administration",
  "pairing-administration",
  "session-administration",
  "secret-inspection"
])

export type InsecureLanCapability = typeof InsecureLanCapability.Type

export const CsrfDigest = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u, { expected: "a lowercase SHA-256 digest" })
).pipe(Schema.brand("CsrfDigest"))

export type CsrfDigest = typeof CsrfDigest.Type

export const CsrfToken = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u, { expected: "a lowercase 256-bit token" })
).pipe(Schema.brand("CsrfToken"))

export type CsrfToken = typeof CsrfToken.Type

const RequestShape = Schema.Struct({
  method: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(16)),
  host: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(260)),
  origin: Schema.Union([Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(2_048)), Schema.Null]),
  csrfToken: Schema.Union([Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512)), Schema.Null]),
  forwardedHost: Schema.Union([Schema.String.check(Schema.isMaxLength(260)), Schema.Null]),
  forwardedProto: Schema.Union([Schema.String.check(Schema.isMaxLength(16)), Schema.Null]),
  remoteAddress: Schema.Union([Schema.String.check(Schema.isMaxLength(64)), Schema.Null])
})

export type RequestShape = typeof RequestShape.Type

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
export class RequestSecurityError extends Schema.TaggedErrorClass<RequestSecurityError>()("RequestSecurityError", {
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
  request: RequestShape
): { readonly host: string; readonly protocol: "http" | "https" } => {
  const trusted = request.remoteAddress !== null &&
    config.trustedProxyAddresses.some((address) => address === request.remoteAddress)
  const host = trusted && request.forwardedHost !== null ? request.forwardedHost : request.host
  const protocol = trusted && request.forwardedProto === "https" ? "https" : config.cookieSecure ? "https" : "http"
  return { host: lowerHost(host), protocol }
}

const authorizeRequestAuthority = Effect.fn("RequestSecurity.authorizeAuthority")(function*(
  config: BindConfig,
  input: unknown
) {
  const request = yield* Schema.decodeUnknownEffect(RequestShape)(input).pipe(
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
  request: RequestShape
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
export const authorizeRequest = Effect.fn("RequestSecurity.authorize")(function*(
  config: BindConfig,
  input: unknown,
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

const fixedTimeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  let difference = left.byteLength ^ right.byteLength
  const length = Math.max(left.byteLength, right.byteLength)
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

/** Hash a CSRF token for storage beside its session without retaining the token. */
export const hashCsrfToken = Effect.fn("RequestSecurity.hashCsrf")(function*(token: string) {
  const cryptoService = yield* Crypto.Crypto
  const decodedToken = yield* Schema.decodeUnknownEffect(CsrfToken)(token).pipe(
    Effect.mapError(() => new RequestSecurityError({ reason: "csrf-rejected" }))
  )
  const bytes = yield* Effect.fromResult(Encoding.decodeHex(decodedToken)).pipe(
    Effect.mapError(() => new RequestSecurityError({ reason: "csrf-rejected" }))
  )
  const digest = yield* cryptoService
    .digest("SHA-256", bytes)
    .pipe(Effect.mapError(() => new RequestSecurityError({ reason: "csrf-rejected" })))
  return CsrfDigest.make(Encoding.encodeHex(digest))
})

/** Verify a supplied CSRF token against the fixed-size stored digest. */
export const verifyCsrfToken = Effect.fn("RequestSecurity.verifyCsrf")(function*(
  token: string | null,
  expectedDigest: string
) {
  if (token === null) return yield* new RequestSecurityError({ reason: "csrf-required" })
  const decodedExpected = yield* Schema.decodeUnknownEffect(CsrfDigest)(expectedDigest).pipe(
    Effect.mapError(() => new RequestSecurityError({ reason: "csrf-rejected" }))
  )
  const actualDigest = yield* hashCsrfToken(token)
  const actual = yield* Effect.fromResult(Encoding.decodeHex(actualDigest)).pipe(
    Effect.mapError(() => new RequestSecurityError({ reason: "csrf-rejected" }))
  )
  const expected = yield* Effect.fromResult(Encoding.decodeHex(decodedExpected)).pipe(
    Effect.mapError(() => new RequestSecurityError({ reason: "csrf-rejected" }))
  )
  if (!fixedTimeEqual(actual, expected)) {
    return yield* new RequestSecurityError({ reason: "csrf-rejected" })
  }
})

/** Insecure HTTP LAN clients cannot perform administration or inspect secrets. */
export const authorizeInsecureLanCapability = (
  config: BindConfig,
  capability: InsecureLanCapability
): Effect.Effect<void, RequestSecurityError> => {
  if (config.transportPolicy !== "insecure-lan") return Effect.void
  if (capability === "release-read" || capability === "release-action" || capability === "release-agent") {
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
  verifySessionCsrf: (csrfToken: Redacted.Redacted<string>) => Effect.Effect<A, E, R>
) {
  const request = yield* authorizeRequestAuthority(authorization.config, authorization.request)
  yield* authorizeMutationOrigin(authorization.config, request)
  if (request.csrfToken === null) return yield* new RequestSecurityError({ reason: "csrf-required" })
  yield* authorizeInsecureLanCapability(authorization.config, authorization.capability)
  return yield* verifySessionCsrf(Redacted.make(request.csrfToken))
})

/** Cookie attributes for the opaque session token; the token itself is never represented here. */
export const sessionCookiePolicy = (config: BindConfig): SessionCookiePolicy => ({
  name: "cc_session",
  httpOnly: true,
  sameSite: "strict",
  path: "/",
  secure: config.cookieSecure
})
