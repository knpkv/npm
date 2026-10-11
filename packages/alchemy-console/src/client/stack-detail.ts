import { Effect } from "effect"
import { type StackId, StackNotFound } from "../api.js"
import type { StackDetailState } from "../views.js"
import { browserReadPolicy, makeApiClient } from "./api-client.js"

/** Discover current IDs before a detail read; a disappeared stack is a real 404 rather than stale content. */
export const readStackDetail = Effect.fn("AlchemyConsole.readStackDetail")(function*(id: StackId) {
  const client = yield* makeApiClient()
  const list = yield* client.stacks.list()
  if (!list.stacks.some((stack) => stack.id === id)) return yield* new StackNotFound({})
  const detail = yield* client.stacks.get({ params: { id } })
  return { _tag: "Ready", stack: detail.state } satisfies StackDetailState
}, (effect) =>
  effect.pipe(
    Effect.catchTags({
      Unauthorized: () => Effect.succeed<StackDetailState>({ _tag: "Unauthorized", reason: "session" }),
      Forbidden: () => Effect.succeed<StackDetailState>({ _tag: "Failed", reason: "forbidden" }),
      StackNotFound: () => Effect.succeed<StackDetailState>({ _tag: "NotFound" }),
      CatalogReadError: (error) => Effect.succeed<StackDetailState>({ _tag: "Failed", reason: error.reason }),
      SchemaError: () => Effect.succeed<StackDetailState>({ _tag: "Failed", reason: "invalid-response" }),
      HttpClientError: () => Effect.succeed<StackDetailState>({ _tag: "Failed", reason: "transport" })
    }),
    browserReadPolicy
  ))
