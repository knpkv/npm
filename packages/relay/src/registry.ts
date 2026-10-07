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
import type { Effect, Schema } from "effect"
import type * as JsonSchema from "effect/JsonSchema"

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

/** Register a capability for Relay. */
export const register = <
  Name extends string,
  Input extends InputSchema,
  Output extends PlainSchema,
  Failure extends FailureSchema,
  Requirements
>(
  capability: Capability<Name, Input, Output, Failure, Requirements>
): RegisteredCapability<Requirements> => {
  const { contract } = capability
  return {
    name: contract.name,
    description: contract.description,
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
