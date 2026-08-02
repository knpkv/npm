import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

import type { ReleasePublicationProvider } from "../../api/agent.js"
import type { ReleaseId } from "../../domain/identifiers.js"
import type { ReleaseAgentTurn } from "../AgentPage.js"
import { makeAuthenticatedMutationClient } from "../authenticatedMutationClient.js"

export const submitBrowserReleasePublication = (input: {
  readonly releaseId: ReleaseId
  readonly provider: ReleasePublicationProvider
  readonly title: string
  readonly markdown: string
}): Promise<{ readonly actionId: string; readonly state: string }> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const client = yield* makeAuthenticatedMutationClient
      return yield* client.agent.submitReleasePublication({
        params: { releaseId: input.releaseId },
        payload: { provider: input.provider, title: input.title, markdown: input.markdown, parentId: null }
      })
    }).pipe(Effect.provide(FetchHttpClient.layer))
  )

class ReleaseAgentProtocolError extends Data.TaggedError("ReleaseAgentProtocolError") {}

const runTurnEffect = Effect.fn("ReleaseAgentTransport.runTurn")(function*(
  input: Parameters<ReleaseAgentTurn>[0]
) {
  const client = yield* makeAuthenticatedMutationClient
  const response = yield* client.agent.turn({
    params: { releaseId: input.releaseId },
    payload: {
      history: input.history,
      ...(input.originPath === undefined ? {} : { originPath: input.originPath }),
      prompt: input.prompt,
      provider: input.provider
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

const loadPresetsEffect = Effect.fn("ReleaseAgentTransport.loadPresets")(function*() {
  const client = yield* makeAuthenticatedMutationClient
  const catalog = yield* client.agent.providers()
  const presets = new Array<"claude" | "codex">()
  for (const provider of catalog.providers) {
    const providerId = String(provider.providerId)
    if (
      provider.health === "available" &&
      provider.capabilities.includes("release-chat") &&
      (providerId === "codex" || providerId === "claude")
    ) {
      presets.push(providerId)
    }
  }
  return presets
})

/** Browser transport for the selected read-only local release-agent preset. */
export const runBrowserReleaseAgentTurn: ReleaseAgentTurn = (input, { signal }) =>
  Effect.runPromise(runTurnEffect(input).pipe(Effect.provide(FetchHttpClient.layer)), { signal })

/** Load only configured local release-agent presets from the redacted catalog. */
export const loadBrowserReleaseAgentPresets = (
  signal: AbortSignal
): Promise<ReadonlyArray<"claude" | "codex">> =>
  Effect.runPromise(loadPresetsEffect().pipe(Effect.provide(FetchHttpClient.layer)), { signal })
