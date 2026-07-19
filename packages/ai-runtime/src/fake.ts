/** Deterministic adapter for persistence and worker acceptance tests. */
import { Effect, Stream } from "effect"

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
        const resolved = typeof script === "function" ? script(snapshot) : script
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
