import { Clock, Effect } from "effect"
import type { StackListState } from "../views.js"
import { browserReadPolicy, makeApiClient } from "./api-client.js"

/** Authenticate empty boundary refusals before typed response decoding; never expose transport causes. */
export const readStackList = Effect.fn("AlchemyConsole.readStackList")(function*() {
  const client = yield* makeApiClient()
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
    browserReadPolicy
  ))
