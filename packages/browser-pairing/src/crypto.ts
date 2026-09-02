import { Crypto, Effect, Encoding, Redacted, Result, Schema } from "effect"
import { BrowserCredential, CredentialDigest } from "./schema.js"

const CREDENTIAL_BYTES = 32

/** Shared failure class; applications map it to their local HTTP/domain errors. */
export class BrowserPairingError extends Schema.TaggedError<BrowserPairingError>()("BrowserPairingError", {
  reason: Schema.Literals(["credential-rejected", "crypto-failed", "invalid-lifetime"])
}) {}

/** Produce a fresh 256-bit credential using the caller's platform crypto service. */
export const issueCredential = Effect.fn("BrowserPairing.issueCredential")(function*() {
  const cryptoService = yield* Crypto.Crypto
  const bytes = yield* cryptoService.randomBytes(CREDENTIAL_BYTES).pipe(
    Effect.mapError(() => new BrowserPairingError({ reason: "crypto-failed" }))
  )
  const decoded = yield* Schema.decodeUnknownEffect(BrowserCredential)(Encoding.encodeHex(bytes)).pipe(
    Effect.mapError(() => new BrowserPairingError({ reason: "crypto-failed" }))
  )
  return Redacted.make(decoded)
})

/** Hash a credential for durable persistence without retaining its plaintext. */
export const hashCredential = Effect.fn("BrowserPairing.hashCredential")(function*(
  credential: Redacted.Redacted<string>
) {
  const decoded = yield* Schema.decodeUnknownEffect(BrowserCredential)(Redacted.value(credential)).pipe(
    Effect.mapError(() => new BrowserPairingError({ reason: "credential-rejected" }))
  )
  const bytes = yield* Effect.fromResult(Encoding.decodeHex(decoded)).pipe(
    Effect.mapError(() => new BrowserPairingError({ reason: "credential-rejected" }))
  )
  const cryptoService = yield* Crypto.Crypto
  const digest = yield* cryptoService.digest("SHA-256", bytes).pipe(
    Effect.mapError(() => new BrowserPairingError({ reason: "crypto-failed" }))
  )
  return CredentialDigest.make(Encoding.encodeHex(digest))
})

const fixedTimeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  let difference = left.byteLength ^ right.byteLength
  const length = Math.max(left.byteLength, right.byteLength)
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

/** Verify a supplied credential against a stored digest in constant time. */
export const verifyCredentialDigest = Effect.fn("BrowserPairing.verifyCredentialDigest")(function*(
  credential: Redacted.Redacted<string>,
  expectedDigest: string
) {
  const expected = yield* Schema.decodeUnknownEffect(CredentialDigest)(expectedDigest).pipe(
    Effect.mapError(() => new BrowserPairingError({ reason: "credential-rejected" }))
  )
  const actual = yield* hashCredential(credential)
  const actualBytes = yield* Effect.fromResult(Encoding.decodeHex(actual)).pipe(
    Effect.mapError(() => new BrowserPairingError({ reason: "credential-rejected" }))
  )
  const expectedBytes = yield* Effect.fromResult(Encoding.decodeHex(expected)).pipe(
    Effect.mapError(() => new BrowserPairingError({ reason: "credential-rejected" }))
  )
  if (!fixedTimeEqual(actualBytes, expectedBytes)) {
    return yield* new BrowserPairingError({ reason: "credential-rejected" })
  }
})

/** Compare validated digests without an early-exit string comparison. */
export const credentialDigestsEqual = (left: CredentialDigest, right: CredentialDigest): boolean => {
  const leftBytes = Encoding.decodeHex(left)
  const rightBytes = Encoding.decodeHex(right)
  return Result.isSuccess(leftBytes) && Result.isSuccess(rightBytes) &&
    fixedTimeEqual(leftBytes.success, rightBytes.success)
}

/** Compare two untrusted credential strings without exposing length or content. */
export const credentialValuesEqual = (left: string, right: string): boolean => {
  const decodedLeft = Schema.decodeUnknownResult(BrowserCredential)(left)
  const decodedRight = Schema.decodeUnknownResult(BrowserCredential)(right)
  if (Result.isFailure(decodedLeft) || Result.isFailure(decodedRight)) return false
  const leftBytes = Encoding.decodeHex(decodedLeft.success)
  const rightBytes = Encoding.decodeHex(decodedRight.success)
  return Result.isSuccess(leftBytes) && Result.isSuccess(rightBytes) &&
    fixedTimeEqual(leftBytes.success, rightBytes.success)
}

/** Validate and calculate a bounded expiry at the edge of an issuance operation. */
export const expiresAt = Effect.fn("BrowserPairing.expiresAt")(function*(now: number, lifetimeMs: number) {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0) {
    return yield* new BrowserPairingError({ reason: "invalid-lifetime" })
  }
  const expiry = now + lifetimeMs
  if (!Number.isSafeInteger(expiry)) return yield* new BrowserPairingError({ reason: "invalid-lifetime" })
  return expiry
})
