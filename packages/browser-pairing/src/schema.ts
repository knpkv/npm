import { Result, Schema } from "effect"

const CREDENTIAL_PATTERN = /^[0-9a-f]{64}$/u

/** A 256-bit browser credential. Keep values redacted except at a transport boundary. */
export const BrowserCredential = Schema.String.check(
  Schema.isPattern(CREDENTIAL_PATTERN, { expected: "a lowercase 256-bit browser credential" })
).pipe(Schema.brand("BrowserCredential"))

export type BrowserCredential = typeof BrowserCredential.Type

/** Pairing code accepted by an unauthenticated confirmation route. */
export const PairingCode = BrowserCredential
export type PairingCode = BrowserCredential

/** Opaque session credential normally delivered through an HttpOnly cookie. */
export const SessionToken = BrowserCredential
export type SessionToken = BrowserCredential

/** Independent mutation proof sent in a request header. */
export const CsrfToken = BrowserCredential
export type CsrfToken = BrowserCredential

/** SHA-256 digest persisted instead of a browser credential. */
export const CredentialDigest = Schema.String.check(
  Schema.isPattern(CREDENTIAL_PATTERN, { expected: "a lowercase SHA-256 credential digest" })
).pipe(Schema.brand("CredentialDigest"))

export type CredentialDigest = typeof CredentialDigest.Type

/** Public confirmation payload shared by unauthenticated pairing endpoints. */
export const PairingConfirmationRequest = Schema.Struct({ pairingCode: PairingCode })
export type PairingConfirmationRequest = typeof PairingConfirmationRequest.Type

/** Secret-free part of a successful pairing response. */
export const PairingConfirmationResponse = Schema.Struct({ csrfToken: CsrfToken })
export type PairingConfirmationResponse = typeof PairingConfirmationResponse.Type

export const OneTimeCredentialState = Schema.Struct({
  expiresAt: Schema.Number,
  consumedAt: Schema.NullOr(Schema.Number),
  revokedAt: Schema.NullOr(Schema.Number)
})

export type OneTimeCredentialState = typeof OneTimeCredentialState.Type

export type OneTimeCredentialDecision = "accepted" | "expired" | "consumed" | "revoked"

/** Expiry is inclusive: a credential at its deadline is no longer usable. */
export const isExpired = (now: number, expiry: number): boolean => now >= expiry

/** Pure state transition guard reusable by durable and in-memory stores. */
export const decideOneTimeCredential = (
  state: OneTimeCredentialState,
  now: number
): OneTimeCredentialDecision => {
  if (state.revokedAt !== null) return "revoked"
  if (state.consumedAt !== null) return "consumed"
  if (isExpired(now, state.expiresAt)) return "expired"
  return "accepted"
}

export interface CredentialCookieOptions {
  readonly name: string
  readonly path: string
  readonly httpOnly: boolean
  readonly sameSite: "strict" | "lax" | "none"
  readonly secure: boolean
  readonly maxAge?: number
}

/** Serialize a credential cookie; credential attributes remain application policy. */
export const serializeCredentialCookie = (
  credential: string,
  options: CredentialCookieOptions
): string => {
  const sameSite = options.sameSite === "strict" ? "Strict" : options.sameSite === "lax" ? "Lax" : "None"
  const parts = [
    `${options.name}=${credential}`,
    ...(options.httpOnly ? ["HttpOnly"] : []),
    `Path=${options.path}`,
    `SameSite=${sameSite}`,
    ...(options.secure ? ["Secure"] : []),
    ...(options.maxAge === undefined ? [] : [`Max-Age=${String(options.maxAge)}`])
  ]
  return parts.join("; ")
}

export type BootstrapTokenRead =
  | { readonly _tag: "missing" }
  | { readonly _tag: "malformed" }
  | { readonly _tag: "present"; readonly token: BrowserCredential }

/** Read a bootstrap token without silently accepting malformed URL fragments. */
export const readBootstrapToken = (hash: string): BootstrapTokenRead => {
  const value = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash).get("bootstrap_token")
  if (value === null) return { _tag: "missing" }
  const decoded = Schema.decodeUnknownResult(BrowserCredential)(value)
  return Result.isSuccess(decoded)
    ? { _tag: "present", token: decoded.success }
    : { _tag: "malformed" }
}

/** Remove a bootstrap fragment while retaining the current route and query. */
export const bootstrapRouteWithoutToken = (pathname: string, search: string): string => `${pathname}${search}`
