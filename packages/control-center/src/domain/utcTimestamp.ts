import { Schema } from "effect"

/**
 * Codec for instants that normalizes accepted ISO-8601 input to UTC and encodes
 * it as a canonical UTC ISO-8601 string.
 */
export const UtcTimestamp = Schema.DateTimeUtcFromString.annotate({
  identifier: "UtcTimestamp"
})

/** Decoded UTC instant used by Control Center domain records. */
export type UtcTimestamp = typeof UtcTimestamp.Type
