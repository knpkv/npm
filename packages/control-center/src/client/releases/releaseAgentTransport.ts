import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"

import { makeControlCenterApiClient } from "../../api/client.js"
import { CsrfToken } from "../../api/session.js"
import type { ReleaseAgentTurn } from "../AgentPage.js"

class MutationProofUnavailable {
  readonly _tag = "ForbiddenApiError"
}

class ReleaseAgentProtocolError {
  readonly _tag = "ReleaseAgentProtocolError"
}

const mutationProof = (): Effect.Effect<CsrfToken, MutationProofUnavailable> =>
  Effect.try({
    try: () => sessionStorage.getItem("cc_csrf"),
    catch: () => new MutationProofUnavailable()
  }).pipe(
    Effect.flatMap((value) =>
      value === null
        ? Effect.fail(new MutationProofUnavailable())
        : Schema.decodeUnknownEffect(CsrfToken)(value).pipe(
          Effect.mapError(() => new MutationProofUnavailable())
        )
    )
  )

const runTurnEffect = Effect.fn("ReleaseAgentTransport.runTurn")(function*(
  input: Parameters<ReleaseAgentTurn>[0]
) {
  const csrfToken = yield* mutationProof()
  const client = yield* makeControlCenterApiClient({
    transformClient: (httpClient) =>
      httpClient.pipe(
        HttpClient.mapRequest(HttpClientRequest.setHeader("x-csrf-token", csrfToken))
      )
  })
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
