import { Clock, Effect } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { AlchemyConsoleApi, Forbidden, Unauthorized } from "../api.js"
import type { StackListState } from "../views.js"

/** Authenticate empty boundary refusals before typed response decoding; never expose transport causes. */
export const readStackList = Effect.fn("AlchemyConsole.readStackList")(function*() {
  const transport = yield* HttpClient.HttpClient
  const client = yield* HttpApiClient.makeWith(AlchemyConsoleApi, {
    httpClient: transport.pipe(HttpClient.transformResponse(Effect.flatMap((response) => {
      if (response.status !== 401 && response.status !== 403) return Effect.succeed(response)
      return response.text.pipe(
        Effect.flatMap(() => Effect.fail(response.status === 401 ? new Unauthorized({}) : new Forbidden({})))
      )
    })))
  })
  const list = yield* client.stacks.list()
  const completedAt = yield* Clock.currentTimeMillis
  return {
    _tag: "Ready",
    list,
    checkedAt: new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(completedAt))
  } satisfies StackListState
}, (effect) =>
  effect.pipe(
    Effect.catchTags({
      Unauthorized: () => Effect.succeed<StackListState>({ _tag: "Unauthorized", reason: "session" }),
      Forbidden: () => Effect.succeed<StackListState>({ _tag: "Failed", reason: "forbidden" }),
      CatalogReadError: (error) => Effect.succeed<StackListState>({ _tag: "Failed", reason: error.reason }),
      SchemaError: () => Effect.succeed<StackListState>({ _tag: "Failed", reason: "invalid-response" }),
      HttpClientError: () => Effect.succeed<StackListState>({ _tag: "Failed", reason: "transport" })
    }),
    Effect.provideService(FetchHttpClient.RequestInit, {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error"
    }),
    Effect.withTracerEnabled(false)
  ))
