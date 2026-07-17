import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

import { makeControlCenterApiClient } from "../../api/client.js"
import type { PluginConnectionTestResult, PluginListResponse } from "../../api/index.js"
import type { PluginConnectionId } from "../../domain/identifiers.js"
import { makeAuthenticatedMutationClient } from "../authenticatedMutationClient.js"

/** Browser boundary for connection administration reads and live tests. */
export interface ConnectionTestTransport {
  readonly list: (signal: AbortSignal) => Promise<PluginListResponse>
  readonly test: (pluginConnectionId: PluginConnectionId, signal: AbortSignal) => Promise<PluginConnectionTestResult>
}

/** Generated-client transport carrying cookies and the current tab's mutation proof. */
export const browserConnectionTestTransport: ConnectionTestTransport = {
  list: (signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.plugins.list()
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  test: (pluginConnectionId, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeAuthenticatedMutationClient
        return yield* client.plugins.testConnection({ params: { pluginConnectionId } })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    )
}
