import { Effect } from "effect"
import type { SourceFailureReason, StackId } from "../api.js"
import type { PlanState } from "../plan.js"
import { browserReadPolicy, makeApiClient } from "./api-client.js"

export type PlanReadResult =
  | { readonly _tag: "Plan"; readonly state: PlanState }
  | { readonly _tag: "Unauthorized"; readonly reason: "session" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Failed"; readonly reason: typeof SourceFailureReason.Type | "forbidden" }

/** Re-read the authenticated publication endpoint. There is no planning or provider execution route. */
export const readStackPlan = Effect.fn("AlchemyConsole.readStackPlan")(function*(id: StackId) {
  const client = yield* makeApiClient()
  return { _tag: "Plan", state: yield* client.stacks.plan({ params: { id } }) } satisfies PlanReadResult
}, (effect) =>
  effect.pipe(
    Effect.catchTags({
      Unauthorized: () => Effect.succeed<PlanReadResult>({ _tag: "Unauthorized", reason: "session" }),
      Forbidden: () => Effect.succeed<PlanReadResult>({ _tag: "Failed", reason: "forbidden" }),
      StackNotFound: () => Effect.succeed<PlanReadResult>({ _tag: "NotFound" }),
      CatalogReadError: (error) => Effect.succeed<PlanReadResult>({ _tag: "Failed", reason: error.reason }),
      SchemaError: () =>
        Effect.succeed<PlanReadResult>({
          _tag: "Plan",
          state: { _tag: "Unverified", reason: "metadata", source: null }
        }),
      HttpClientError: () => Effect.succeed<PlanReadResult>({ _tag: "Plan", state: { _tag: "Unreachable" } })
    }),
    browserReadPolicy
  ))
