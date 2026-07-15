import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

const TOKEN_BYTES = 32
const PREPARATION_DOMAIN = "governed-action/preparation/v1"
const PERMIT_DOMAIN = "governed-action/permit/v1"
const RECOVERY_DOMAIN = "governed-action/recovery/v1"

const encodedToken = <const Brand extends string>(brand: Brand) =>
  Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{64}$/u, { expected: "a lowercase 256-bit secret" })
  ).pipe(Schema.brand(brand))

const redactedToken = <const Brand extends string>(brand: Brand, label: string) =>
  Schema.RedactedFromValue(encodedToken(brand), { label, disallowEncode: true })

const encodedDigest = <const Brand extends string>(brand: Brand) =>
  Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{64}$/u, { expected: "a lowercase SHA-256 digest" })
  ).pipe(Schema.brand(brand))

/** One-use capability that binds final preflight to an authorized action head. */
export const GovernedActionPreparationToken = redactedToken(
  "GovernedActionPreparationToken",
  "governed-action-preparation-token"
)

/** Decoded dispatch-preparation capability. */
export type GovernedActionPreparationToken = typeof GovernedActionPreparationToken.Type

/** One-use capability that authorizes recording the result of one provider dispatch. */
export const GovernedActionPermitToken = redactedToken(
  "GovernedActionPermitToken",
  "governed-action-permit-token"
)

/** Decoded provider-dispatch capability. */
export type GovernedActionPermitToken = typeof GovernedActionPermitToken.Type

/** One-use capability that authorizes one non-replaying provider reconciliation. */
export const GovernedActionRecoveryToken = redactedToken(
  "GovernedActionRecoveryToken",
  "governed-action-recovery-token"
)

/** Decoded provider-recovery capability. */
export type GovernedActionRecoveryToken = typeof GovernedActionRecoveryToken.Type

/** Fixed-size preparation digest persisted instead of the live capability. */
export const GovernedActionPreparationTokenDigest = encodedDigest("GovernedActionPreparationTokenDigest")

/** Decoded at-rest preparation-token digest. */
export type GovernedActionPreparationTokenDigest = typeof GovernedActionPreparationTokenDigest.Type

/** Fixed-size permit digest persisted instead of the live capability. */
export const GovernedActionPermitTokenDigest = encodedDigest("GovernedActionPermitTokenDigest")

/** Decoded at-rest permit-token digest. */
export type GovernedActionPermitTokenDigest = typeof GovernedActionPermitTokenDigest.Type

/** Fixed-size recovery digest persisted instead of the live capability. */
export const GovernedActionRecoveryTokenDigest = encodedDigest("GovernedActionRecoveryTokenDigest")

/** Decoded at-rest recovery-token digest. */
export type GovernedActionRecoveryTokenDigest = typeof GovernedActionRecoveryTokenDigest.Type

/** Closed cryptographic failure while issuing or hashing an execution capability. */
export class GovernedActionExecutionTokenError extends Schema.TaggedErrorClass<GovernedActionExecutionTokenError>()(
  "GovernedActionExecutionTokenError",
  { operation: Schema.Literals(["digest", "issue"]) }
) {}

interface IssuedToken<Token, Digest> {
  readonly digest: Digest
  readonly token: Token
}

const digestBytes = Effect.fn("GovernedActionExecutionToken.digestBytes")(function*(
  domain: string,
  bytes: Uint8Array
) {
  const cryptoService = yield* Crypto.Crypto
  const domainBytes = yield* Effect.fromResult(Encoding.decodeBase64(Encoding.encodeBase64(domain))).pipe(
    Effect.mapError(() => new GovernedActionExecutionTokenError({ operation: "digest" }))
  )
  const input = new Uint8Array(domainBytes.byteLength + 1 + bytes.byteLength)
  input.set(domainBytes)
  input.set(bytes, domainBytes.byteLength + 1)
  const digest = yield* cryptoService.digest("SHA-256", input).pipe(
    Effect.mapError(() => new GovernedActionExecutionTokenError({ operation: "digest" }))
  )
  return Encoding.encodeHex(digest)
})

const issueBytes = Effect.fn("GovernedActionExecutionToken.issueBytes")(function*() {
  const cryptoService = yield* Crypto.Crypto
  const bytes = yield* cryptoService.randomBytes(TOKEN_BYTES).pipe(
    Effect.mapError(() => new GovernedActionExecutionTokenError({ operation: "issue" }))
  )
  return { bytes, encoded: Encoding.encodeHex(bytes) }
})

const digestEncoded = Effect.fn("GovernedActionExecutionToken.digestEncoded")(function*(
  domain: string,
  encoded: string
) {
  const bytes = yield* Effect.fromResult(Encoding.decodeHex(encoded)).pipe(
    Effect.mapError(() => new GovernedActionExecutionTokenError({ operation: "digest" }))
  )
  if (bytes.byteLength !== TOKEN_BYTES) {
    return yield* new GovernedActionExecutionTokenError({ operation: "digest" })
  }
  return yield* digestBytes(domain, bytes)
})

/** Issue a preparation capability and its safe at-rest digest. */
export const issueGovernedActionPreparationToken = Effect.fn(
  "GovernedActionExecutionToken.issuePreparation"
)(function*(): Effect.fn.Return<
  IssuedToken<GovernedActionPreparationToken, GovernedActionPreparationTokenDigest>,
  GovernedActionExecutionTokenError,
  Crypto.Crypto
> {
  const { bytes, encoded } = yield* issueBytes()
  return {
    token: yield* Schema.decodeUnknownEffect(GovernedActionPreparationToken)(encoded).pipe(
      Effect.mapError(() => new GovernedActionExecutionTokenError({ operation: "issue" }))
    ),
    digest: GovernedActionPreparationTokenDigest.make(yield* digestBytes(PREPARATION_DOMAIN, bytes))
  }
})

/** Issue a dispatch permit and its safe at-rest digest. */
export const issueGovernedActionPermitToken = Effect.fn(
  "GovernedActionExecutionToken.issuePermit"
)(function*(): Effect.fn.Return<
  IssuedToken<GovernedActionPermitToken, GovernedActionPermitTokenDigest>,
  GovernedActionExecutionTokenError,
  Crypto.Crypto
> {
  const { bytes, encoded } = yield* issueBytes()
  return {
    token: yield* Schema.decodeUnknownEffect(GovernedActionPermitToken)(encoded).pipe(
      Effect.mapError(() => new GovernedActionExecutionTokenError({ operation: "issue" }))
    ),
    digest: GovernedActionPermitTokenDigest.make(yield* digestBytes(PERMIT_DOMAIN, bytes))
  }
})

/** Issue a recovery capability and its safe at-rest digest. */
export const issueGovernedActionRecoveryToken = Effect.fn(
  "GovernedActionExecutionToken.issueRecovery"
)(function*(): Effect.fn.Return<
  IssuedToken<GovernedActionRecoveryToken, GovernedActionRecoveryTokenDigest>,
  GovernedActionExecutionTokenError,
  Crypto.Crypto
> {
  const { bytes, encoded } = yield* issueBytes()
  return {
    token: yield* Schema.decodeUnknownEffect(GovernedActionRecoveryToken)(encoded).pipe(
      Effect.mapError(() => new GovernedActionExecutionTokenError({ operation: "issue" }))
    ),
    digest: GovernedActionRecoveryTokenDigest.make(yield* digestBytes(RECOVERY_DOMAIN, bytes))
  }
})

/** Hash a preparation capability for exact database lookup. */
export const digestGovernedActionPreparationToken = (
  token: GovernedActionPreparationToken
): Effect.Effect<GovernedActionPreparationTokenDigest, GovernedActionExecutionTokenError, Crypto.Crypto> =>
  Effect.map(
    digestEncoded(PREPARATION_DOMAIN, Redacted.value(token)),
    GovernedActionPreparationTokenDigest.make
  )

/** Hash a dispatch permit for exact database lookup. */
export const digestGovernedActionPermitToken = (
  token: GovernedActionPermitToken
): Effect.Effect<GovernedActionPermitTokenDigest, GovernedActionExecutionTokenError, Crypto.Crypto> =>
  Effect.map(digestEncoded(PERMIT_DOMAIN, Redacted.value(token)), GovernedActionPermitTokenDigest.make)

/** Hash a recovery capability for exact database lookup. */
export const digestGovernedActionRecoveryToken = (
  token: GovernedActionRecoveryToken
): Effect.Effect<GovernedActionRecoveryTokenDigest, GovernedActionExecutionTokenError, Crypto.Crypto> =>
  Effect.map(digestEncoded(RECOVERY_DOMAIN, Redacted.value(token)), GovernedActionRecoveryTokenDigest.make)
