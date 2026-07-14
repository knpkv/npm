import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"

const CANONICAL_NONNEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9][0-9]*)$/u
const MAXIMUM_SAFE_INTEGER_DIGITS = String(Number.MAX_SAFE_INTEGER).length

const NonNegativeSafeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** Canonical unsigned-decimal HTTP representation of a nonnegative safe integer. */
export const CanonicalNonNegativeIntegerFromString = Schema.String.check(
  Schema.isMaxLength(MAXIMUM_SAFE_INTEGER_DIGITS),
  Schema.isPattern(CANONICAL_NONNEGATIVE_INTEGER_PATTERN, {
    expected: "a canonical unsigned-decimal integer"
  })
).pipe(
  Schema.decodeTo(NonNegativeSafeInteger, {
    decode: SchemaGetter.transform((value) => Number(value)),
    encode: SchemaGetter.transform((value) => String(value))
  })
)
