/**
 * Cryptographic UUID v4 generation via Effect's platform Crypto service.
 *
 * @internal
 */
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as PlatformError from "effect/PlatformError"

/**
 * Generate a cryptographically secure UUID v4.
 * Uses Effect's platform Crypto service.
 *
 * @category Utilities
 */
export const generateUUID = (): Effect.Effect<string, PlatformError.PlatformError, Crypto.Crypto> =>
  Effect.gen(function*() {
    const cryptoService = yield* Crypto.Crypto
    return yield* cryptoService.randomUUIDv4
  })
