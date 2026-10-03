/**
 * Optional struct keys that shadow `Object.prototype` members.
 *
 * @packageDocumentation
 */
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"

/** `Object.prototype` members that Jira payloads use as ordinary field names. */
export type PrototypeKey = "toString"

/**
 * Optional key for a field named after an `Object.prototype` member, such as Jira's `toString`.
 *
 * Effect resolves declared struct keys with `in`, so a JSON object that omits `toString` presents the inherited
 * `Object.prototype.toString`. Only that exact inherited function decodes as an absent key; any other value must
 * satisfy `schema`. Use it in place of `Schema.optionalKey(schema)` for these keys; the encoded and decoded types
 * stay those of `Schema.optionalKey(schema)`.
 */
export const ownOptionalKey = <S extends Schema.Top>(key: PrototypeKey, schema: S) => {
  const inherited = Object.prototype[key]
  // Typed `never`: the inherited member is not a domain value and never survives decoding.
  const isInherited = Predicate.compose(Predicate.isFunction, (member: Function): member is never => member === inherited)
  const InheritedMember = Schema.declare(isInherited, { expected: `the inherited Object.prototype.${key}` })
  return Schema.optionalKey(Schema.Union([schema, InheritedMember])).pipe(
    Schema.decodeTo(Schema.optionalKey(Schema.toType(schema)), {
      decode: SchemaGetter.transformOptional(Option.filter(Predicate.not(isInherited))),
      encode: SchemaGetter.passthrough()
    })
  )
}
