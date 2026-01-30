/**
 * Content hashing utilities.
 *
 * @module
 */
import * as Effect from "effect/Effect"
import * as crypto from "node:crypto"
import { ContentHash } from "./Brand.js"

/**
 * Compute SHA256 hash of a string.
 *
 * @example
 * ```typescript
 * import { hashContent } from "@knpkv/atlassian-common"
 * import * as Effect from "effect/Effect"
 *
 * const hash = Effect.runSync(hashContent("hello world"))
 * // => "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
 * ```
 *
 * @category Hash
 */
export const hashContent = (content: string): Effect.Effect<ContentHash> =>
  Effect.sync(() => {
    const hash = crypto.createHash("sha256").update(content, "utf8").digest("hex")
    return ContentHash(hash)
  })

/**
 * Compute SHA256 hash of a buffer.
 *
 * @category Hash
 */
export const hashBuffer = (buffer: Buffer | Uint8Array): Effect.Effect<ContentHash> =>
  Effect.sync(() => {
    const hash = crypto.createHash("sha256").update(buffer).digest("hex")
    return ContentHash(hash)
  })

/**
 * Check if two hashes are equal.
 *
 * @category Hash
 */
export const hashEquals = (a: ContentHash, b: ContentHash): boolean => a === b

/**
 * Synchronous version of hashContent for simple use cases.
 *
 * @category Hash
 */
export const hashContentSync = (content: string): ContentHash => {
  const hash = crypto.createHash("sha256").update(content, "utf8").digest("hex")
  return ContentHash(hash)
}
