/**
 * Content hashing utilities for change detection.
 *
 * @module
 * @internal
 */
import * as crypto from "node:crypto"
import type { ContentHash } from "../Brand.js"

/**
 * Compute SHA256 hash of content.
 *
 * @param content - The content to hash
 * @returns The hex-encoded SHA256 hash
 *
 * @internal
 */
export const computeHash = (content: string): ContentHash =>
  crypto.createHash("sha256").update(content, "utf8").digest("hex") as ContentHash
