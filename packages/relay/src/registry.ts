/**
 * Capabilities as the harness holds them: input, output and failure types closed over, so one list
 * holds many capabilities without `any`.
 *
 * @module
 */
import { Effect, Predicate, Schema } from "effect"
import type * as JsonSchema from "effect/JsonSchema"
import type { Capability, CapabilityEffect, ObjectRef, PendingAction } from "./model.js"

/** The model called a capability with arguments its input schema rejects. */
export class CapabilityInputInvalid extends Schema.TaggedError<CapabilityInputInvalid>()("CapabilityInputInvalid", {
  capability: Schema.String,
  issue: Schema.String
}) {}

/** The capability ran and failed. `message` is what the model sees; it names the failure. */
export class CapabilityFailed extends Schema.TaggedError<CapabilityFailed>()("CapabilityFailed", {
  capability: Schema.String,
  message: Schema.String
}) {}

/** A capability's output could not be encoded as JSON: a bug in the capability's output schema. */
export class CapabilityOutputInvalid extends Schema.TaggedError<CapabilityOutputInvalid>()("CapabilityOutputInvalid", {
  capability: Schema.String,
  issue: Schema.String
}) {}

/** What a successful call hands back: JSON for the model, citations for the dock. */
export interface CapabilityResult {
  readonly output: Schema.Json
  readonly cites: ReadonlyArray<ObjectRef>
}

/** One registered capability, its types erased behind closures. */
export interface RegisteredCapability<Requirements> {
  readonly name: string
  readonly description: string
  readonly effect: CapabilityEffect
  readonly reversible: boolean
  /** JSON Schema of the input, for the model's tool list and argument validation. */
  readonly parameters: JsonSchema.JsonSchema
  /** `args` is the model's JSON for this call; it is decoded here, at the boundary. */
  readonly describe: (args: Schema.Json) => Effect.Effect<PendingAction, CapabilityInputInvalid>
  readonly run: (
    args: Schema.Json
  ) => Effect.Effect<
    CapabilityResult,
    CapabilityInputInvalid | CapabilityFailed | CapabilityOutputInvalid,
    Requirements
  >
}

const failureMessage = <Failure>(failure: Failure): string =>
  Predicate.hasProperty(failure, "message") && Predicate.isString(failure.message) && failure.message !== ""
    ? failure.message
    : Predicate.hasProperty(failure, "_tag") && Predicate.isString(failure._tag)
    ? failure._tag
    : "The capability failed without a message"

const jsonSchemaOf = (schema: Schema.Top): JsonSchema.JsonSchema => {
  const document = Schema.toJsonSchemaDocument(schema)
  return Object.keys(document.definitions).length === 0
    ? document.schema
    : { ...document.schema, $defs: document.definitions }
}

const decodeJson = Schema.decodeUnknownEffect(Schema.Json)

/** Register a capability: decode its input at the boundary and encode its output as JSON. */
export const register = <Input, Output, Failure, Requirements>(
  capability: Capability<Input, Output, Failure, Requirements>
): RegisteredCapability<Requirements> => {
  const decodeInput = Schema.decodeUnknownEffect(capability.input)
  const encodeOutput = Schema.encodeUnknownEffect(Schema.toCodecJson(capability.output))
  const decode = (args: Schema.Json) =>
    decodeInput(args).pipe(
      Effect.mapError((issue) => new CapabilityInputInvalid({ capability: capability.name, issue: String(issue) }))
    )
  return {
    name: capability.name,
    description: capability.description,
    effect: capability.effect,
    reversible: capability.reversible,
    parameters: jsonSchemaOf(capability.input),
    describe: (args) => Effect.map(decode(args), capability.describe),
    run: (args) =>
      Effect.gen(function*() {
        const input = yield* decode(args)
        const output = yield* capability.handler(input).pipe(
          Effect.mapError((failure) =>
            new CapabilityFailed({ capability: capability.name, message: failureMessage(failure) })
          )
        )
        const json = yield* encodeOutput(output).pipe(
          Effect.flatMap(decodeJson),
          Effect.mapError((issue) => new CapabilityOutputInvalid({ capability: capability.name, issue: String(issue) }))
        )
        return { output: json, cites: capability.cites(output) }
      })
  }
}
