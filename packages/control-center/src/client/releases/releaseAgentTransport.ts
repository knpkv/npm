import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

import type { ReleaseAgentTurn } from "../AgentPage.js"
import { makeAuthenticatedMutationClient } from "../authenticatedMutationClient.js"

class ReleaseAgentProtocolError extends Data.TaggedError("ReleaseAgentProtocolError") {}

const runTurnEffect = Effect.fn("ReleaseAgentTransport.runTurn")(function*(
  input: Parameters<ReleaseAgentTurn>[0]
) {
  const client = yield* makeAuthenticatedMutationClient
  const response = yield* client.agent.turn({
    params: { releaseId: input.releaseId },
    payload: {
      history: input.history,
      prompt: input.prompt,
      provider: "codex"
    }
  })
  if (response.releaseId !== input.releaseId || response.release.releaseId !== input.releaseId) {
    return yield* Effect.fail(new ReleaseAgentProtocolError())
  }
  return {
    eventCursor: response.eventCursor,
    provider: response.provider,
    release: response.release,
    reply: response.reply
  }
})

/** Browser transport for the default read-only Codex release agent. */
export const runBrowserReleaseAgentTurn: ReleaseAgentTurn = (input, { signal }) =>
  Effect.runPromise(runTurnEffect(input).pipe(Effect.provide(FetchHttpClient.layer)), { signal })
