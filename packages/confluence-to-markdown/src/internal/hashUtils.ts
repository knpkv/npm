/**
 * Content hashing utilities for change detection.
 *
 * @module
 * @internal
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { ContentHash } from "../Brand.js"

/**
 * Hash computation service.
 * This allows mocking in tests.
 *
 * @category Services
 */
export interface HashService {
  readonly computeSha256: (content: string) => Effect.Effect<ContentHash>
}

/**
 * Tag for the HashService.
 *
 * @category Services
 */
export class HashServiceTag extends Context.Service<
  HashServiceTag,
  HashService
>()("@knpkv/confluence-to-markdown/HashService") {}

/**
 * Create a HashService layer from a hash function.
 * This allows injecting platform-specific implementations.
 *
 * @param hashFn - Function that computes SHA256 hash
 * @category Layers
 */
export const makeHashServiceLive = (
  hashFn: (content: string) => Promise<string>
): Layer.Layer<HashServiceTag> =>
  Layer.succeed(
    HashServiceTag,
    {
      computeSha256: (content: string) =>
        Effect.promise(() => hashFn(content)).pipe(
          Effect.map((hash) => hash as ContentHash)
        )
    }
  )

/**
 * Default implementation using Effect's platform Crypto service.
 *
 * @category Layers
 */
const HashServiceFromCrypto: Layer.Layer<HashServiceTag, never, Crypto.Crypto> = Layer.effect(
  HashServiceTag,
  Effect.gen(function*() {
    const cryptoService = yield* Crypto.Crypto
    return {
      computeSha256: (content: string) =>
        cryptoService.digest("SHA-256", new TextEncoder().encode(content)).pipe(
          Effect.orDie,
          Effect.map((hashArray) =>
            Array.from(hashArray)
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("") as ContentHash
          )
        )
    }
  })
)

export const HashServiceLive: Layer.Layer<HashServiceTag> = HashServiceFromCrypto.pipe(Layer.provide(NodeCrypto.layer))

/**
 * Compute SHA256 hash of content.
 *
 * @param content - The content to hash
 * @returns The hex-encoded SHA256 hash
 *
 * @internal
 */
export const computeHash = (
  content: string
): Effect.Effect<ContentHash, never, HashServiceTag> =>
  Effect.gen(function*() {
    const hashService = yield* HashServiceTag
    return yield* hashService.computeSha256(content)
  })
