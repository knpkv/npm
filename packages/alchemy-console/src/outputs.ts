import { Effect, Schema } from "effect"
import { type OutputSummary, StateReadError } from "./schema.js"

const OutputDictionary = Schema.Record(Schema.String, Schema.Unknown)
const OutputKeys = Schema.Array(
  Schema.NonEmptyString.check(Schema.isMaxLength(256), Schema.isPattern(/^\P{Cc}+$/u))
).check(Schema.isMaxLength(1000))
const encodingMarkers = ["__redacted__", "__date__", "__duration__"]

/** Decode keys only, without inspecting values. Encoding envelopes invalidate the whole root, including siblings. */
export const decodeOutputs = Effect.fn("AlchemyConsole.decodeOutputs")(function*(text: string) {
  const dictionary = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OutputDictionary))(text).pipe(
    Effect.mapError(() => new StateReadError({ reason: "invalid-state" }))
  )
  if (encodingMarkers.some((key) => Object.hasOwn(dictionary, key))) {
    return yield* new StateReadError({ reason: "invalid-state" })
  }
  const keys = yield* Schema.decodeUnknownEffect(OutputKeys)(Object.keys(dictionary)).pipe(
    Effect.mapError(() => new StateReadError({ reason: "invalid-state" }))
  )
  return [...keys].sort().map((key): OutputSummary => ({ key, value: { _tag: "Hidden" }, description: null }))
})
