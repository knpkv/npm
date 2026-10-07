/**
 * The projection-neutral path every surface takes to call a capability with untrusted JSON: decode the
 * input at the boundary, run the handler, encode the output and any declared failure as JSON.
 *
 * **Mental model**
 *
 * - **Surfaces add only their own concerns.** Relay adds its confirmation gate and events, MCP its
 *   tool result, HTTP its status codes. Decoding, encoding and failure shape live here once.
 * - **Declared failures are data; everything else is a defect.** A failure in the contract's union is
 *   returned as {@link CapabilityFailed} with its encoded value, `message` and `fix`, safe to show a
 *   model or a person. A defect stays a defect; a surface reports it as a generic internal error and
 *   never leaks its message.
 *
 * @module
 */
import * as Effect from "effect/Effect"
import type * as JsonSchema from "effect/JsonSchema"
import * as Schema from "effect/Schema"
import type {
  Capability,
  FailureSchema,
  GatedContract,
  InputSchema,
  ObjectRef,
  PendingAction,
  PlainSchema
} from "./Contract.js"

/** The caller passed arguments the contract's input schema rejects. */
export class CapabilityInputInvalid extends Schema.TaggedError<CapabilityInputInvalid>()("CapabilityInputInvalid", {
  capability: Schema.String,
  issue: Schema.String
}) {
  override get message(): string {
    return `Invalid arguments for ${this.capability}: ${this.issue}`
  }
}

/** The capability failed with one of its declared failures. `failure` is that failure encoded as JSON. */
export class CapabilityFailed extends Schema.TaggedError<CapabilityFailed>()("CapabilityFailed", {
  capability: Schema.String,
  tag: Schema.String,
  reason: Schema.String,
  fix: Schema.String,
  failure: Schema.Json
}) {
  override get message(): string {
    return this.reason
  }
}

/** A result could not be encoded with the contract's own schema: a bug in the capability, not the caller. */
export class CapabilityEncodingFailed extends Schema.TaggedError<CapabilityEncodingFailed>()(
  "CapabilityEncodingFailed",
  { capability: Schema.String, issue: Schema.String }
) {
  override get message(): string {
    return `${this.capability} produced a value its schema cannot encode: ${this.issue}`
  }
}

/** A successful call: the output as JSON, and the objects it cites. */
export interface InvocationResult {
  readonly output: Schema.Json
  readonly cites: ReadonlyArray<ObjectRef>
}

/** JSON Schema for a contract's input, with its definitions inlined under `$defs` when it has any. */
export const inputJsonSchema = (contract: { readonly input: InputSchema }): JsonSchema.JsonSchema => {
  const document = Schema.toJsonSchemaDocument(contract.input)
  return Object.keys(document.definitions).length === 0
    ? document.schema
    : { ...document.schema, $defs: document.definitions }
}

const decodeInput = <Input extends InputSchema>(
  contract: { readonly name: string; readonly input: Input },
  args: Schema.Json
): Effect.Effect<Input["Type"], CapabilityInputInvalid> =>
  Schema.decodeUnknownEffect(Schema.toCodecJson(contract.input))(args).pipe(
    Effect.mapError((issue) => new CapabilityInputInvalid({ capability: contract.name, issue: String(issue) }))
  )

const encodeAs = <S extends PlainSchema>(contract: { readonly name: string }, schema: S, value: S["Type"]) =>
  Schema.encodeUnknownEffect(Schema.toCodecJson(schema))(value).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
    Effect.mapError((issue) => new CapabilityEncodingFailed({ capability: contract.name, issue: String(issue) }))
  )

/**
 * Call a capability with untrusted JSON arguments. Gating is the surface's job: call this only after a
 * gated contract's action has been agreed to.
 */
export const invoke = <
  Name extends string,
  Input extends InputSchema,
  Output extends PlainSchema,
  Failure extends FailureSchema,
  Requirements
>(
  capability: Capability<Name, Input, Output, Failure, Requirements>,
  args: Schema.Json
): Effect.Effect<
  InvocationResult,
  CapabilityInputInvalid | CapabilityFailed | CapabilityEncodingFailed,
  Requirements
> =>
  Effect.gen(function*() {
    const { contract } = capability
    const input = yield* decodeInput(contract, args)
    const output = yield* capability.handler(input).pipe(
      Effect.catch((failure: Failure["Type"]) =>
        Effect.flatMap(encodeAs(contract, contract.failure, failure), (encoded) =>
          Effect.fail(
            new CapabilityFailed({
              capability: contract.name,
              tag: failure._tag,
              reason: failure.message,
              fix: failure.fix,
              failure: encoded
            })
          ))
      )
    )
    return { output: yield* encodeAs(contract, contract.output, output), cites: contract.cites(output) }
  })

/** The action a gated contract would take for these arguments, decoded at the boundary. */
export const describeCall = <
  Name extends string,
  Input extends InputSchema,
  Output extends PlainSchema,
  Failure extends FailureSchema
>(
  contract: GatedContract<Name, Input, Output, Failure>,
  args: Schema.Json
): Effect.Effect<PendingAction, CapabilityInputInvalid> =>
  Effect.map(decodeInput(contract, args), (input) => contract.describe(input))
