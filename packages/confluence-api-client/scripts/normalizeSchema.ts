import type * as JsonSchema from "effect/JsonSchema"
import * as Predicate from "effect/Predicate"

// Effect imports a JSON Schema `pattern` with the Unicode flag and later revives it
// only when `new RegExp(source, "u").source === source`. RegExp escapes `/` in its
// source, so Confluence's `^/wiki/api/v2/databases/` fails that round-trip and the
// whole client fails to generate. The escaped source matches exactly the same
// strings, so patterns are rewritten to it before Effect sees them.
const canonicalPattern = (pattern: string): string => {
  try {
    return new RegExp(pattern, "u").source
  } catch {
    // Not a Unicode-mode pattern: left as is, so Effect reports it by name.
    return pattern
  }
}

/**
 * The generator's `onEnter` hook: OpenAPI 3.0 `nullable` becomes a JSON Schema
 * null branch, unreliable `default`/`examples` metadata is dropped, and `pattern`
 * is canonicalized as above.
 */
export const normalizeSchema = (schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema => {
  const { default: _default, examples: _examples, ...withoutMetadata } = schema
  const patterned = Predicate.isString(withoutMetadata.pattern)
    ? { ...withoutMetadata, pattern: canonicalPattern(withoutMetadata.pattern) }
    : withoutMetadata
  if (!Predicate.hasProperty(patterned, "nullable")) return patterned
  const { nullable, ...normalized } = patterned
  return nullable === true ? { anyOf: [normalized, { type: "null" }] } : normalized
}
