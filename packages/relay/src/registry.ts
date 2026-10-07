/**
 * Capabilities as the harness holds them: one list of `@knpkv/capability` capabilities with their
 * types closed over, so the harness can run any of them from the model's JSON without `any`.
 *
 * Decoding, encoding and failure handling are the capability package's (`invoke`, `describeCall`);
 * this module only erases types and records what the gate needs.
 *
 * @module
 */
import {
  type Capability,
  type CapabilityEncodingFailed,
  type CapabilityFailed,
  type CapabilityInputInvalid,
  describeCall,
  type FailureSchema,
  inputJsonSchema,
  type InputSchema,
  type InvocationResult,
  invoke,
  type PendingAction,
  type PlainSchema
} from "@knpkv/capability"
import { Option, Schema } from "effect"
import type { Effect } from "effect"
import type * as JsonSchema from "effect/JsonSchema"
import type { WriteReceipt } from "./model.js"

/** What a person must agree to before a gated capability runs. */
export interface Gate {
  readonly access: "write" | "host"
  readonly reversible: boolean
  readonly describe: (
    args: Schema.Json
  ) => Effect.Effect<PendingAction, CapabilityInputInvalid | CapabilityEncodingFailed>
}

/** One registered capability, its types erased behind closures. */
export interface RegisteredCapability<Requirements> {
  readonly name: string
  readonly description: string
  /** `undefined` for a read: it runs without anyone agreeing first. */
  readonly gate: Gate | undefined
  /** A short display name, for activity rows. */
  readonly label: string
  /** A display-safe line for one call: a write's action verb, or the label. */
  readonly summarize: (args: Schema.Json) => string
  /** What a completed call made, for writes whose product projects a receipt. */
  readonly receipt: (result: InvocationResult) => WriteReceipt | undefined
  /** JSON Schema of the input, for the model's tool list and argument validation. */
  readonly parameters: JsonSchema.JsonSchema
  /** `args` is the model's JSON for this call; the capability decodes it at the boundary. */
  readonly run: (
    args: Schema.Json
  ) => Effect.Effect<
    InvocationResult,
    CapabilityInputInvalid | CapabilityFailed | CapabilityEncodingFailed,
    Requirements
  >
}

/** How the dock shows a capability's calls. Every field has a default. */
export interface DisplayOptions<Output extends PlainSchema> {
  /** Defaults to the capability name with spaces: `get_pull_request` is "get pull request". */
  readonly label?: string
  /** A write's receipt, from its decoded output: a display-safe line, the provider's id, a link. */
  readonly receipt?: (output: Output["Type"]) => WriteReceipt
}

/** Register a capability for Relay, with how the dock shows its calls. */
export const register = <
  Name extends string,
  Input extends InputSchema,
  Output extends PlainSchema,
  Failure extends FailureSchema,
  Requirements
>(
  capability: Capability<Name, Input, Output, Failure, Requirements>,
  display: DisplayOptions<Output> = {}
): RegisteredCapability<Requirements> => {
  const { contract } = capability
  const label = display.label ?? contract.name.replaceAll("_", " ")
  const decodeInput = Schema.decodeUnknownOption(contract.input)
  const decodeOutput = Schema.decodeUnknownOption(contract.output)
  const project = display.receipt
  return {
    name: contract.name,
    description: contract.description,
    label,
    summarize: (args) =>
      contract.access === "read"
        ? label
        : Option.match(decodeInput(args), { onNone: () => label, onSome: (input) => contract.describe(input).verb }),
    receipt: (result) =>
      project === undefined ? undefined : Option.getOrUndefined(Option.map(decodeOutput(result.output), project)),
    gate: contract.access === "read"
      ? undefined
      : {
        access: contract.access,
        reversible: contract.reversible,
        describe: (args) => describeCall(contract, args)
      },
    parameters: inputJsonSchema(contract),
    run: (args) => invoke(capability, args)
  }
}
