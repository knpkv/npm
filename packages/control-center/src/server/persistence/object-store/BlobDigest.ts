import { Schema } from "effect"

const LOWERCASE_SHA_256_PATTERN = /^[0-9a-f]{64}$/

/** Exact lowercase hexadecimal encoding of a SHA-256 digest. */
export const BlobDigest = Schema.String.check(
  Schema.isPattern(LOWERCASE_SHA_256_PATTERN, {
    expected: "a 64-character lowercase SHA-256 digest"
  })
).pipe(Schema.brand("BlobDigest"))

/** Decoded content digest. */
export type BlobDigest = typeof BlobDigest.Type
