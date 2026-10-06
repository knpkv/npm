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
import { Cause, Data, Schema } from "effect"
import type { Effect, Exit } from "effect"
import type { PendingAction } from "./model.js"
import type { CapabilityResult, RegisteredCapability } from "./registry.js"

/** Runs an Effect from inside Pi with the harness's services. */
export type EffectRunner<Requirements> = <A, E>(
  effect: Effect.Effect<A, E, Requirements>,
  signal: AbortSignal | undefined
) => Promise<Exit.Exit<A, E>>

/** The dock-facing side of the gate: ask a person about one call and wait for the answer. */
export interface ConfirmationBroker {
  readonly ask: (request: {
    readonly conversationId: string
    readonly callId: string
    readonly action: PendingAction
    readonly reversible: boolean
  }) => Promise<boolean>
}

const decodeJson = Schema.decodeUnknownOption(Schema.Json)

/** Reads rerun after a crash; writes and host actions never do. */
const replaySafe = { replay: "safe" } satisfies { readonly replay: "safe" }

const declined = (verb: string): string => `The user declined: ${verb}. Do not retry it unless they ask again.`

const resultText = (result: CapabilityResult): string => JSON.stringify(result.output)

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
      ...(capability.effect === "read" && replaySafe),
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
          throw new RelayToolFailure({
            capability: capability.name,
            message: `${capability.name} failed: ${Cause.pretty(exit.cause)}`
          })
        }
        await api.details({ cites: exit.value.cites.map((ref) => ({ ...ref })) }, context)
        return { content: [{ type: "text", text: resultText(exit.value) }] }
      }
    })
  )
  const gate = hook(ToolTask, {
    beforeTool: async (call, api, context) => {
      const capability = byName.get(call.name)
      if (capability === undefined || capability.effect === "read") return undefined
      if (capability.effect === "host") {
        return { block: `${call.name} needs a herdr Approval, which Relay cannot request yet.` }
      }
      const memoKey = `relay.decision.${call.id}`
      const remembered = await api.memo<boolean>(memoKey, context)
      const decision = remembered ?? await (async () => {
        const action = await runEffect(capability.describe(call.arguments), context.abortSignal)
        if (action._tag === "Failure") return false
        const allowed = await broker.ask({
          conversationId: String(api.conversationId),
          callId: call.id,
          action: action.value,
          reversible: capability.reversible
        })
        return api.memo(memoKey, allowed, context)
      })()
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
