import type { Stream } from "effect"

import type { BlobDigest } from "./BlobDigest.js"
import type { BlobStoreError } from "./BlobStoreError.js"

/** Optional bounded segment for stream and range reads. */
export interface BlobRange {
  readonly offset: number
  readonly length: number
}

/** Metadata and bytes for a lazy file stream. */
export interface BlobReadStream {
  readonly digest: BlobDigest
  readonly sizeBytes: number
  readonly integrity: "not-verified"
  readonly bytes: Stream.Stream<Uint8Array, BlobStoreError>
}

/** Bounded range bytes; callers can separately request whole-object verification. */
export interface BlobRangeRead {
  readonly digest: BlobDigest
  readonly sizeBytes: number
  readonly integrity: "not-verified"
  readonly bytes: Uint8Array
}

/** Integrity-check result, independent of SQL durability metadata. */
export interface BlobVerification {
  readonly digest: BlobDigest
  readonly sizeBytes: number
}
