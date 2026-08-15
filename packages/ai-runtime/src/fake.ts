/** Deterministic adapters for persistence, worker, and tool-loop tests. */
import { Effect, Layer, Stream } from "effect"
import * as AiError from "effect/unstable/ai/AiError"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import type * as Response from "effect/unstable/ai/Response"

import * as Predicate from "effect/Predicate"
import type { AgentProviderError, AgentRunRequest, AgentRuntimeEvent } from "./model.js"
import { captureAgentRunRequest } from "./requestSnapshot.js"
import { layerAgentRuntime } from "./runtime.js"

export interface DeterministicAgentScript {
  readonly events: ReadonlyArray<AgentRuntimeEvent>
  readonly failure?: AgentProviderError
}

/** A deterministic fake plus its captured, ordered requests. */
export const makeDeterministicAgent = (
  script: DeterministicAgentScript | ((request: AgentRunRequest) => DeterministicAgentScript)
) => {
  const requests: Array<AgentRunRequest> = []
  const adapter = {
    run: (request: AgentRunRequest): Stream.Stream<AgentRuntimeEvent, AgentProviderError> =>
      Stream.unwrap(Effect.sync(() => {
        const snapshot = captureAgentRunRequest(request)
        const resolved = Predicate.isFunction(script) ? script(snapshot) : script
        const events = Stream.fromIterable(resolved.events)
        requests.push(snapshot)
        return resolved.failure === undefined
          ? events
          : events.pipe(Stream.concat(Stream.fail(resolved.failure)))
      }))
  }
  return {
    layer: layerAgentRuntime(adapter),
    get requests(): ReadonlyArray<AgentRunRequest> {
      return [...requests]
    }
  }
}

export type DeterministicLanguageModelTurn =
  | {
    readonly _tag: "failure"
    readonly failure: AiError.AiError
  }
  | {
    readonly _tag: "response"
    readonly parts: ReadonlyArray<Response.PartEncoded>
  }

export type DeterministicLanguageModelScript =
  | ReadonlyArray<DeterministicLanguageModelTurn>
  | ((
    request: LanguageModel.ProviderOptions,
    index: number
  ) => DeterministicLanguageModelTurn)

const exhaustedModel = (): AiError.AiError =>
  AiError.make({
    method: "generateText",
    module: "@knpkv/ai-runtime/fake",
    reason: new AiError.UnknownError({
      description: "Deterministic language-model script exhausted."
    })
  })

/** Scripted Effect AI model plus its ordered provider-neutral requests. */
export const makeDeterministicLanguageModel = (
  script: DeterministicLanguageModelScript
) => {
  const requests: Array<LanguageModel.ProviderOptions> = []
  let index = 0

  const next = (request: LanguageModel.ProviderOptions): DeterministicLanguageModelTurn => {
    const turn = Predicate.isFunction(script)
      ? script(request, index)
      : script[index] ?? { _tag: "failure", failure: exhaustedModel() }
    index += 1
    requests.push(request)
    return turn
  }

  const makeService = LanguageModel.make({
    generateText: (request) =>
      Effect.suspend(() => {
        const turn = next(request)
        return turn._tag === "failure"
          ? Effect.fail(turn.failure)
          : Effect.succeed([...turn.parts])
      }),
    streamText: () => Stream.fail(exhaustedModel())
  })

  return {
    layer: Layer.effect(LanguageModel.LanguageModel, makeService),
    get requests(): ReadonlyArray<LanguageModel.ProviderOptions> {
      return [...requests]
    }
  }
}
