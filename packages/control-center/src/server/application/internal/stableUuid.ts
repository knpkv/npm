import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import { Base64, Hex } from "effect/encoding"

/** Derive a stable v7-shaped identity while retaining the caller's typed failures. */
export const stableUuid = Effect.fn("StableUuid.derive")(function*<Failure>(
  cryptoService: Crypto.Crypto,
  identity: string,
  failure: (operation: "encoding" | "digest") => Failure
) {
  const bytes = yield* Effect.fromResult(Base64.decode(Base64.encode(identity))).pipe(
    Effect.mapError(() => failure("encoding"))
  )
  const digest = yield* cryptoService.digest("SHA-256", bytes).pipe(
    Effect.mapError(() => failure("digest"))
  )
  const hex = Hex.encode(digest)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
})
