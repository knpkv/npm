import { Crypto, Effect, Encoding, Redacted, Ref, Result, Schema } from "effect"

const pairingCodePattern = /^[0-9a-f]{64}$/u

export const LanWorkPairingCode = Schema.String.check(
  Schema.isPattern(pairingCodePattern)
).pipe(Schema.brand("LanWorkPairingCode"))
export type LanWorkPairingCode = typeof LanWorkPairingCode.Type

const LanWorkSessionToken = Schema.String.check(
  Schema.isPattern(pairingCodePattern)
).pipe(Schema.brand("LanWorkSessionToken"))
type LanWorkSessionToken = typeof LanWorkSessionToken.Type

export const LanWorkPairRequestInput = Schema.Record(Schema.String, Schema.Unknown)
export type LanWorkPairRequestInput = typeof LanWorkPairRequestInput.Type

export const LanWorkPairRequest = Schema.Struct({ pairingCode: LanWorkPairingCode })
export type LanWorkPairRequest = typeof LanWorkPairRequest.Type

export class LanWorkPairingMalformedError extends Schema.TaggedError<LanWorkPairingMalformedError>()(
  "LanWorkPairingMalformedError",
  { detail: Schema.String }
) {}

export class LanWorkPairingRejectedError extends Schema.TaggedError<LanWorkPairingRejectedError>()(
  "LanWorkPairingRejectedError",
  { detail: Schema.String }
) {}

export class LanWorkPairingExpiredError extends Schema.TaggedError<LanWorkPairingExpiredError>()(
  "LanWorkPairingExpiredError",
  { detail: Schema.String }
) {}

export class LanWorkPairingReplayedError extends Schema.TaggedError<LanWorkPairingReplayedError>()(
  "LanWorkPairingReplayedError",
  { detail: Schema.String }
) {}

export class LanWorkSessionRequiredError extends Schema.TaggedError<LanWorkSessionRequiredError>()(
  "LanWorkSessionRequiredError",
  { detail: Schema.String }
) {}

export class LanWorkSessionRejectedError extends Schema.TaggedError<LanWorkSessionRejectedError>()(
  "LanWorkSessionRejectedError",
  { detail: Schema.String }
) {}

export class LanWorkOriginRejectedError extends Schema.TaggedError<LanWorkOriginRejectedError>()(
  "LanWorkOriginRejectedError",
  { detail: Schema.String }
) {}

export class LanWorkSelectionMalformedError extends Schema.TaggedError<LanWorkSelectionMalformedError>()(
  "LanWorkSelectionMalformedError",
  { detail: Schema.String }
) {}

export class LanWorkConfigurationError extends Schema.TaggedError<LanWorkConfigurationError>()(
  "LanWorkConfigurationError",
  { detail: Schema.String }
) {}

export class LanWorkCryptoError extends Schema.TaggedError<LanWorkCryptoError>()(
  "LanWorkCryptoError",
  { cause: Schema.Defect(), operation: Schema.String }
) {}

export const lanWorkPairingLifetimeMs = 5 * 60 * 1000
export const lanWorkSessionCookieName = "herdr_lan_work"

export type LanWorkListenerOptions = {
  readonly address: string
  readonly host?: string
  readonly port: number
}

type PairingState = {
  readonly consumed: boolean
  readonly sessionDigest: string | null
}

type PairingDecision =
  | "accepted"
  | "expired"
  | "replayed"
  | "rejected"

const equalDigest = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

const decodeGeneratedCode = Effect.fn("LanWork.decodeGeneratedCode")(function*(value: string) {
  return yield* Schema.decodeUnknownEffect(LanWorkPairingCode)(value).pipe(
    Effect.mapError(
      (cause) =>
        new LanWorkCryptoError({
          cause,
          operation: "lan_work.pairing_code"
        })
    )
  )
})

const decodeGeneratedSession = Effect.fn("LanWork.decodeGeneratedSession")(function*(value: string) {
  return yield* Schema.decodeUnknownEffect(LanWorkSessionToken)(value).pipe(
    Effect.mapError(
      (cause) =>
        new LanWorkCryptoError({
          cause,
          operation: "lan_work.session_token"
        })
    )
  )
})

const makeDigest = Effect.fn("LanWork.makeDigest")(function*(cryptoService: Crypto.Crypto, value: string) {
  return yield* cryptoService.digest("SHA-256", new TextEncoder().encode(value)).pipe(
    Effect.map(Encoding.encodeHex),
    Effect.mapError(
      (cause) =>
        new LanWorkCryptoError({
          cause,
          operation: "lan_work.digest"
        })
    )
  )
})

const randomPairingCode = Effect.fn("LanWork.randomPairingCode")(function*(cryptoService: Crypto.Crypto) {
  const bytes = yield* cryptoService.randomBytes(32).pipe(
    Effect.mapError(
      (cause) =>
        new LanWorkCryptoError({
          cause,
          operation: "lan_work.random_token"
        })
    )
  )
  return yield* decodeGeneratedCode(Encoding.encodeHex(bytes))
})

const randomSessionToken = Effect.fn("LanWork.randomSessionToken")(function*(cryptoService: Crypto.Crypto) {
  const bytes = yield* cryptoService.randomBytes(32).pipe(
    Effect.mapError(
      (cause) =>
        new LanWorkCryptoError({
          cause,
          operation: "lan_work.random_token"
        })
    )
  )
  return yield* decodeGeneratedSession(Encoding.encodeHex(bytes))
})

export type LanWorkPairing = {
  readonly pairingCode: Redacted.Redacted<string>
  readonly expiresAt: number
  readonly consume: (
    code: LanWorkPairingCode
  ) => Effect.Effect<
    Redacted.Redacted<string>,
    LanWorkPairingRejectedError | LanWorkPairingExpiredError | LanWorkPairingReplayedError | LanWorkCryptoError
  >
  readonly authorizeSession: (
    token: string | undefined
  ) => Effect.Effect<void, LanWorkSessionRequiredError | LanWorkSessionRejectedError | LanWorkCryptoError>
}

export const makeLanWorkPairing = Effect.fn("LanWork.makePairing")(function*(now: () => number) {
  const cryptoService = yield* Crypto.Crypto
  const pairingCode = yield* randomPairingCode(cryptoService)
  const pairingValue: string = pairingCode
  const pairingDigest = yield* makeDigest(cryptoService, pairingValue)
  const expiresAt = now() + lanWorkPairingLifetimeMs
  const state = yield* Ref.make<PairingState>({ consumed: false, sessionDigest: null })

  const consume = Effect.fn("LanWorkPairing.consume")(function*(code: LanWorkPairingCode) {
    const candidateDigest = yield* makeDigest(cryptoService, code)
    const decision = yield* Ref.modify<PairingState, PairingDecision>(state, (current) => {
      if (!equalDigest(candidateDigest, pairingDigest)) return ["rejected", current]
      if (current.consumed) return ["replayed", current]
      if (now() >= expiresAt) return ["expired", current]
      return ["accepted", { ...current, consumed: true }]
    })
    switch (decision) {
      case "rejected":
        return yield* new LanWorkPairingRejectedError({ detail: "pairing code rejected" })
      case "expired":
        return yield* new LanWorkPairingExpiredError({ detail: "pairing code expired" })
      case "replayed":
        return yield* new LanWorkPairingReplayedError({ detail: "pairing code already used" })
      case "accepted": {
        const session = yield* randomSessionToken(cryptoService)
        const sessionDigest = yield* makeDigest(cryptoService, session)
        yield* Ref.update(state, (current) => ({ ...current, sessionDigest }))
        return Redacted.make(session)
      }
    }
  })

  const authorizeSession = Effect.fn("LanWorkPairing.authorizeSession")(function*(token: string | undefined) {
    if (token === undefined) {
      return yield* new LanWorkSessionRequiredError({ detail: "LAN Work browser pairing required" })
    }
    const decoded = Schema.decodeUnknownResult(LanWorkSessionToken)(token)
    if (Result.isFailure(decoded)) {
      return yield* new LanWorkSessionRejectedError({ detail: "LAN Work browser session rejected" })
    }
    const digest = yield* makeDigest(cryptoService, decoded.success)
    const current = yield* Ref.get(state)
    if (current.sessionDigest === null || !equalDigest(digest, current.sessionDigest)) {
      return yield* new LanWorkSessionRejectedError({ detail: "LAN Work browser session rejected" })
    }
  })

  return { authorizeSession, consume, expiresAt, pairingCode: Redacted.make(pairingValue) } satisfies LanWorkPairing
})

export const decodeLanWorkPairRequest = Effect.fn("LanWork.decodePairRequest")(
  function*(input: LanWorkPairRequestInput) {
    return yield* Schema.decodeUnknownEffect(LanWorkPairRequest, { onExcessProperty: "error" })(input).pipe(
      Effect.mapError(
        (cause) =>
          new LanWorkPairingMalformedError({
            detail: `invalid LAN Work pairing request: ${String(cause)}`
          })
      )
    )
  }
)

export const readLanWorkSessionCookie = (cookieHeader: string | undefined): string | undefined => {
  if (cookieHeader === undefined) return undefined
  for (const part of cookieHeader.split(";")) {
    const [name, ...valueParts] = part.trim().split("=")
    if (name === lanWorkSessionCookieName) {
      const value = valueParts.join("=")
      return value === "" ? undefined : value
    }
  }
  return undefined
}

export const lanWorkSessionCookie = (token: Redacted.Redacted<string>): string =>
  `${lanWorkSessionCookieName}=${Redacted.value(token)}; HttpOnly; Path=/; SameSite=Strict`
