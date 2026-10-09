/**
 * Relay's Pi extension: every registered capability as a Pi tool, and the permission gate as the one
 * `beforeTool` hook in front of all of them.
 *
 * **Mental model**
 *
 * - **Reads replay, writes never do.** A `read` capability is `replay: "safe"`, so a crash mid-call
 *   reruns it. A `write` or `host` capability is not, so Pi gives the model an `interrupted` result
 *   instead of running it twice.
 * - **The gate decides once per call, durably.** For `write`, the hook asks the person through
 *   {@link ConfirmationBroker} and memoises the answer under the call id, so a restart neither asks again
 *   after a decision nor runs a declined action. `host` is refused until herdr Approvals are wired (H3).
 *
 * This module is a Promise boundary: Pi runs the hook and the tools.
 *
 * @module
 */
import type { Context as ChordContext } from "@earendil-works/chord"
import { Type } from "@earendil-works/pi-ai"
import { defineExtension, defineTool, hook, ToolTask } from "@earendil-works/pi-durable"
import type { Extension } from "@earendil-works/pi-durable"
import type {
  CapabilityEncodingFailed,
  CapabilityFailed,
  CapabilityInputInvalid,
  InvocationResult,
  PendingAction
} from "@knpkv/capability"
import { Cause, Data, Effect, Schema } from "effect"
import type { Exit, Option } from "effect"
import type { RegisteredCapability } from "./registry.js"

/** Runs an Effect from inside Pi with the harness's services. */
export type EffectRunner<Requirements> = <A, E>(
  effect: Effect.Effect<A, E, Requirements>,
  signal: AbortSignal | undefined
) => Promise<Exit.Exit<A, E>>

/** The dock-facing side of the gate: ask a person about one call and wait for the answer. */
export interface ConfirmationBroker {
  /** Resolves with the person's answer; rejects when `signal` aborts (the run was cancelled). */
  readonly ask: (request: {
    readonly conversationId: string
    readonly callId: string
    readonly action: PendingAction
    readonly reversible: boolean
  }, signal: AbortSignal | undefined) => Promise<boolean>
}

const decodeJson = Schema.decodeUnknownOption(Schema.Json)

/** Reads rerun after a crash; writes and host actions never do. */
const replaySafe = { replay: "safe" } satisfies { readonly replay: "safe" }

const declined = (verb: string): string => `The user declined: ${verb}. Do not retry it unless they ask again.`

/** Arguments that passed Pi's JSON Schema but not the capability's own decode; the person is never asked. */
const invalidArguments = (verb: string, cause: string): string =>
  `${verb} got invalid arguments, so nobody was asked: ${cause}`

const resultText = (result: InvocationResult): string => JSON.stringify(result.output)

/** What the model reads when a call fails: the declared reason and fix, never a defect's internals. */
const modelVisibleFailure = (
  name: string,
  failure: Option.Option<CapabilityFailed | CapabilityInputInvalid | CapabilityEncodingFailed>
): string => {
  if (failure._tag === "None") return `${name} failed unexpectedly. Tell the user it did not complete.`
  switch (failure.value._tag) {
    case "CapabilityFailed":
      return `${failure.value.reason} — ${failure.value.fix}`
    case "CapabilityInputInvalid":
      return `${name} got invalid arguments: ${failure.value.issue}`
    case "CapabilityEncodingFailed":
      return `${name} failed unexpectedly. Tell the user it did not complete.`
  }
}

/** Build the `relay` Pi extension for one product's capabilities. */
export const relayExtension = <Requirements>(
  capabilities: ReadonlyArray<RegisteredCapability<Requirements>>,
  runEffect: EffectRunner<Requirements>,
  broker: ConfirmationBroker
): Extension => {
  const byName = new Map(capabilities.map((capability) => [capability.name, capability]))
  const tools = capabilities.map((capability) =>
    defineTool({
      name: capability.name,
      description: capability.description,
      parameters: Type.Unsafe(capability.parameters),
      ...(capability.gate === undefined && replaySafe),
      execute: async (args, api, context: ChordContext) => {
        // Pi validated `args` against the capability's JSON Schema; decode it to JSON for the capability.
        const json = decodeJson(args)
        if (json._tag === "None") {
          throw new RelayToolFailure({
            capability: capability.name,
            message: `${capability.name} got non-JSON arguments`
          })
        }
        const exit = await runEffect(capability.run(json.value), context.abortSignal)
        if (exit._tag === "Failure") {
          const failure = Cause.findErrorOption(exit.cause)
          if (failure._tag === "None") {
            // A defect or an undeclared error: logged here, never shown to the model.
            await runEffect(
              Effect.logError(`Relay capability ${capability.name} failed unexpectedly`, exit.cause),
              undefined
            )
          }
          throw new RelayToolFailure({
            capability: capability.name,
            message: modelVisibleFailure(capability.name, failure)
          })
        }
        const receipt = capability.receipt(exit.value)
        await api.details({
          cites: exit.value.cites.map((ref) => ({ ...ref })),
          ...(receipt !== undefined && { receipt: { ...receipt } })
        }, context)
        return { content: [{ type: "text", text: resultText(exit.value) }] }
      }
    })
  )
  const gate = hook(ToolTask, {
    beforeTool: async (call, api, context) => {
      const capability = byName.get(call.name)
      // Pi refuses unregistered tools before this hook, but another extension's tools would reach it.
      if (capability === undefined) return { block: `${call.name} is not a Relay capability.` }
      const gate = capability.gate
      if (gate === undefined) return undefined
      if (gate.access === "host") {
        return { block: `${call.name} needs a herdr Approval, which Relay cannot request yet.` }
      }
      const memoKey = `relay.decision.${call.id}`
      const remembered = await api.memo<boolean>(memoKey, context)
      if (remembered !== undefined) return remembered ? undefined : { block: declined(call.name) }
      // Arguments the confirmation can't show are refused with their reason, never asked about or read as a decline.
      const action = await runEffect(gate.describe(call.arguments), context.abortSignal)
      if (action._tag === "Failure") {
        const failure = Cause.findErrorOption(action.cause)
        return {
          block: failure._tag === "Some" && failure.value._tag === "CapabilityInputInvalid"
            ? invalidArguments(call.name, failure.value.issue)
            : modelVisibleFailure(call.name, failure)
        }
      }
      const allowed = await broker.ask({
        conversationId: String(api.conversationId),
        callId: call.id,
        action: action.value,
        reversible: gate.reversible
      }, context.abortSignal)
      const decision = await api.memo(memoKey, allowed, context)
      return decision ? undefined : { block: declined(call.name) }
    }
  })
  return defineExtension({ name: "relay", tools, hooks: [gate] })
}

/**
 * A capability failed. Pi turns a thrown error into an error tool result for the model; the message is
 * what the model reads, so it names the capability and the failure.
 */
export class RelayToolFailure extends Data.TaggedError("RelayToolFailure")<{
  readonly capability: string
  readonly message: string
}> {}
