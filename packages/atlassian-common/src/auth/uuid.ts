/**
 * UUID generation utilities.
 *
 * @module
 */
import * as Effect from "effect/Effect"

/**
 * Generate a cryptographically secure UUID v4.
 * Uses Web Crypto API randomUUID (Node.js 19+, all modern browsers).
 *
 * @category Utilities
 */
export const generateUUID = (): Effect.Effect<string> => Effect.sync(() => globalThis.crypto.randomUUID())
