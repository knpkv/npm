import { Redacted, Result, Schema } from "effect"

const CREDENTIAL_PATTERN = /^[0-9a-f]{64}$/u
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u
const CredentialValue = Schema.String.check(
  Schema.isPattern(CREDENTIAL_PATTERN, { expected: "a lowercase 256-bit browser credential" })
)

/** A 256-bit browser credential. Keep values redacted except at a transport boundary. */
export const BrowserCredential = CredentialValue.pipe(Schema.brand("BrowserCredential"))

export type BrowserCredential = typeof BrowserCredential.Type

/** Pairing code accepted by an unauthenticated confirmation route. */
export const PairingCode = CredentialValue.pipe(Schema.brand("PairingCode"))
export type PairingCode = typeof PairingCode.Type

/** Opaque session credential normally delivered through an HttpOnly cookie. */
export const SessionToken = CredentialValue.pipe(Schema.brand("SessionToken"))
export type SessionToken = typeof SessionToken.Type

/** Independent mutation proof sent in a request header. */
export const CsrfToken = CredentialValue.pipe(Schema.brand("CsrfToken"))
export type CsrfToken = typeof CsrfToken.Type

/** SHA-256 digest persisted instead of a browser credential. */
export const CredentialDigest = Schema.String.check(
  Schema.isPattern(CREDENTIAL_PATTERN, { expected: "a lowercase SHA-256 credential digest" })
).pipe(Schema.brand("CredentialDigest"))

export type CredentialDigest = typeof CredentialDigest.Type

/** Credential-bearing confirmation payload containing the one-time pairing proof. */
export const PairingConfirmationRequest = Schema.Struct({ pairingCode: PairingCode })
export type PairingConfirmationRequest = typeof PairingConfirmationRequest.Type

/** Credential-bearing response containing the CSRF mutation proof. */
export const PairingConfirmationResponse = Schema.Struct({ csrfToken: CsrfToken })
export type PairingConfirmationResponse = typeof PairingConfirmationResponse.Type

export const OneTimeCredentialState = Schema.Struct({
  expiresAt: Schema.Number.check(Schema.isInt()),
  consumedAt: Schema.NullOr(Schema.Number.check(Schema.isInt())),
  revokedAt: Schema.NullOr(Schema.Number.check(Schema.isInt()))
})

export type OneTimeCredentialState = typeof OneTimeCredentialState.Type

export type OneTimeCredentialDecision = "accepted" | "expired" | "consumed" | "revoked" | "invalid"

/** Expiry is inclusive: a credential at its deadline is no longer usable. */
export const isExpired = (now: number, expiry: number): boolean =>
  !Number.isSafeInteger(now) || !Number.isSafeInteger(expiry) || now >= expiry

/** Pure state transition guard reusable by durable and in-memory stores. */
export const decideOneTimeCredential = (
  state: OneTimeCredentialState,
  now: number
): OneTimeCredentialDecision => {
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(state.expiresAt) ||
    (state.consumedAt !== null && !Number.isSafeInteger(state.consumedAt)) ||
    (state.revokedAt !== null && !Number.isSafeInteger(state.revokedAt))
  ) return "invalid"
  if (state.revokedAt !== null) return "revoked"
  if (state.consumedAt !== null) return "consumed"
  if (isExpired(now, state.expiresAt)) return "expired"
  return "accepted"
}

/** A cookie value or attribute contained a delimiter, control character, or invalid credential. */
export class CredentialCookieError extends Schema.TaggedError<CredentialCookieError>()(
  "CredentialCookieError",
  { reason: Schema.Literals(["invalid-credential", "invalid-attribute", "invalid-max-age"]) }
) {}

export interface CredentialCookieOptions {
  readonly name: string
  readonly path: string
  readonly httpOnly: boolean
  readonly sameSite: "strict" | "lax" | "none"
  readonly secure: boolean
  readonly maxAge?: number
  readonly sourceOrigin?: string
}

const CredentialCookieOptionsSchema = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  httpOnly: Schema.Boolean,
  sameSite: Schema.Literals(["strict", "lax", "none"]),
  secure: Schema.Boolean,
  maxAge: Schema.optionalKey(Schema.Number),
  sourceOrigin: Schema.optionalKey(Schema.String)
})

const isLoopbackIpv4 = (hostname: string): boolean => {
  const octets = hostname.split(".")
  return octets.length === 4 &&
    octets[0] === "127" &&
    octets.slice(1).every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
}

const isChromiumLocalhost = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase()
  return isLoopbackIpv4(normalized) ||
    normalized === "[::1]" ||
    normalized === "localhost" ||
    normalized === "localhost." ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".localhost.")
}

/** Serialize a validated credential cookie without allowing header injection or invalid lifetimes. */
export const serializeCredentialCookie: (
  credential: Redacted.Redacted<SessionToken>,
  options: CredentialCookieOptions
) => string = (credential: Redacted.Redacted<SessionToken>, options: CredentialCookieOptions): string => {
  const value = Redacted.isRedacted(credential) ? Redacted.value(credential) : String(credential)
  const decoded = Schema.decodeUnknownResult(BrowserCredential)(value)
  if (Result.isFailure(decoded)) throw new CredentialCookieError({ reason: "invalid-credential" })
  const decodedOptions = Schema.decodeUnknownResult(CredentialCookieOptionsSchema)(options)
  if (Result.isFailure(decodedOptions)) throw new CredentialCookieError({ reason: "invalid-attribute" })
  const validatedOptions = decodedOptions.success
  const invalidPath = (value: string): boolean =>
    value.length === 0 || Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return !((code >= 0x20 && code <= 0x3a) || (code >= 0x3c && code <= 0x7e))
    })
  const normalizedName = validatedOptions.name.toLowerCase()
  const hasRecognizedPrefix = normalizedName.startsWith("__host-http-") ||
    normalizedName.startsWith("__http-") ||
    normalizedName.startsWith("__host-") ||
    normalizedName.startsWith("__secure-")
  const sourceUrl = validatedOptions.sourceOrigin !== undefined && URL.canParse(validatedOptions.sourceOrigin)
    ? new URL(validatedOptions.sourceOrigin)
    : undefined
  const sourceOriginIsTrustworthy = sourceUrl !== undefined &&
    (sourceUrl.protocol === "https:" ||
      (sourceUrl.protocol === "http:" && isChromiumLocalhost(sourceUrl.hostname)))
  const invalidSecureSource = validatedOptions.secure &&
    (validatedOptions.sourceOrigin === undefined || !sourceOriginIsTrustworthy)
  const invalidReservedPrefix = (normalizedName.startsWith("__host-http-") &&
    (!validatedOptions.secure || !validatedOptions.httpOnly || validatedOptions.path !== "/")) ||
    (normalizedName.startsWith("__http-") && (!validatedOptions.secure || !validatedOptions.httpOnly)) ||
    (normalizedName.startsWith("__host-") && (!validatedOptions.secure || validatedOptions.path !== "/")) ||
    (normalizedName.startsWith("__secure-") && !validatedOptions.secure) ||
    (hasRecognizedPrefix && !sourceOriginIsTrustworthy)
  if (
    !COOKIE_NAME_PATTERN.test(validatedOptions.name) ||
    invalidPath(validatedOptions.path) ||
    !validatedOptions.path.startsWith("/") ||
    invalidReservedPrefix ||
    invalidSecureSource ||
    (validatedOptions.sourceOrigin !== undefined && sourceUrl === undefined)
  ) {
    throw new CredentialCookieError({ reason: "invalid-attribute" })
  }
  if (
    validatedOptions.maxAge !== undefined &&
    (!Number.isSafeInteger(validatedOptions.maxAge) || validatedOptions.maxAge < 0)
  ) {
    throw new CredentialCookieError({ reason: "invalid-max-age" })
  }
  if (validatedOptions.sameSite === "none" && !validatedOptions.secure) {
    throw new CredentialCookieError({ reason: "invalid-attribute" })
  }
  const sameSite = validatedOptions.sameSite === "strict"
    ? "Strict"
    : validatedOptions.sameSite === "lax"
    ? "Lax"
    : validatedOptions.sameSite === "none"
    ? "None"
    : undefined
  if (sameSite === undefined) throw new CredentialCookieError({ reason: "invalid-attribute" })
  const parts = [
    `${validatedOptions.name}=${decoded.success}`,
    ...(validatedOptions.httpOnly ? ["HttpOnly"] : []),
    `Path=${validatedOptions.path}`,
    `SameSite=${sameSite}`,
    ...(validatedOptions.secure ? ["Secure"] : []),
    ...(validatedOptions.maxAge === undefined ? [] : [`Max-Age=${String(validatedOptions.maxAge)}`])
  ]
  return parts.join("; ")
}

export type BootstrapTokenRead =
  | { readonly _tag: "missing" }
  | { readonly _tag: "malformed" }
  | { readonly _tag: "present"; readonly token: Redacted.Redacted<PairingCode> }

/** Read a bootstrap token without silently accepting malformed URL fragments. */
export const readBootstrapToken = (hash: string): BootstrapTokenRead => {
  const value = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash).get("bootstrap_token")
  if (value === null) return { _tag: "missing" }
  const decoded = Schema.decodeUnknownResult(PairingCode)(value)
  return Result.isSuccess(decoded)
    ? { _tag: "present", token: Redacted.make(decoded.success) }
    : { _tag: "malformed" }
}

/** Remove a bootstrap fragment while retaining the current route and query. */
export const bootstrapRouteWithoutToken = (pathname: string, search: string): string => `${pathname}${search}`
