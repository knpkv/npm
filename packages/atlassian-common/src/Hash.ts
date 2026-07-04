/**
 * SHA256 content hashing via Effect's platform `Crypto` service, returning branded {@link ContentHash} values.
 *
 * **Mental model**
 *
 * - **Service-backed cryptography**: {@link hashContent} and {@link hashBuffer}
 *   use the `Crypto` service from Effect context, so applications provide the
 *   platform implementation at the runtime edge.
 *
 * **Common tasks**
 *
 * - Hash a string: {@link hashContent}
 * - Hash a buffer: {@link hashBuffer}
 * - Compare hashes: {@link hashEquals}
 *
 * @module
 */
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import type * as PlatformError from "effect/PlatformError"
import { ContentHash } from "./Brand.js"

const textEncoder = new TextEncoder()

const digestSha256 = (
  bytes: Uint8Array
): Effect.Effect<ContentHash, PlatformError.PlatformError, Crypto.Crypto> =>
  Effect.gen(function*() {
    const cryptoService = yield* Crypto.Crypto
    const digest = yield* cryptoService.digest("SHA-256", bytes)
    return ContentHash(Encoding.encodeHex(digest))
  })

/**
 * Compute SHA256 hash of a string.
 *
 * @example
 * ```typescript
 * import * as Crypto from "effect/Crypto"
 * import * as Effect from "effect/Effect"
 * import { hashContent } from "@knpkv/atlassian-common"
 *
 * declare const cryptoService: Crypto.Crypto
 * const hash = Effect.runSync(hashContent("hello world").pipe(Effect.provideService(Crypto.Crypto, cryptoService)))
 * // => "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
 * ```
 *
 * @category Hash
 */
export const hashContent = (content: string): Effect.Effect<ContentHash, PlatformError.PlatformError, Crypto.Crypto> =>
  digestSha256(textEncoder.encode(content))

/**
 * Compute SHA256 hash of a buffer.
 *
 * @category Hash
 */
export const hashBuffer = (
  buffer: Uint8Array
): Effect.Effect<ContentHash, PlatformError.PlatformError, Crypto.Crypto> => digestSha256(buffer)

/**
 * Check if two hashes are equal.
 *
 * @category Hash
 */
export const hashEquals = (a: ContentHash, b: ContentHash): boolean => a === b
