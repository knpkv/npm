import { Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { BoardView } from "../model.js"

export const readBoard = Effect.fn("Monitor.readBoard")(
  function*(boardId: string, key: string) {
    const client = yield* HttpClient.HttpClient
    const response = yield* HttpClient.withScope(client).get(`/boards/${boardId}`, {
      headers: { authorization: `Bearer ${key}` }
    })
    const data = response.status === 200 ? yield* HttpClientResponse.schemaBodyJson(BoardView)(response) : null
    return { status: response.status, data }
  },
  Effect.provideService(FetchHttpClient.RequestInit, { credentials: "omit", cache: "no-store", redirect: "error" }),
  Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
  // Browser request entry point owns and closes its transport for each poll.
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(FetchHttpClient.layer),
  Effect.timeout("5 seconds"),
  Effect.scoped
)
