import { HttpApiBuilder } from "@effect/platform"
import { PRService } from "@knpkv/codecommit-core"
import { Effect } from "effect"
import { ApiError, CodeCommitApi } from "../Api.js"

export const SubscriptionsLive = HttpApiBuilder.group(
  CodeCommitApi,
  "subscriptions",
  (handlers) =>
    Effect.gen(function*() {
      const prService = yield* PRService.PRService

      return handlers
        .handle("subscribe", ({ payload }) =>
          prService.subscribe(payload.awsAccountId, payload.pullRequestId).pipe(
            Effect.map(() => "ok"),
            Effect.mapError((e) => new ApiError({ message: `Subscription failed: ${String(e)}` }))
          ))
        .handle("unsubscribe", ({ payload }) =>
          prService.unsubscribe(payload.awsAccountId, payload.pullRequestId).pipe(
            Effect.map(() => "ok"),
            Effect.mapError((e) => new ApiError({ message: `Subscription failed: ${String(e)}` }))
          ))
        .handle("list", () => prService.getSubscriptions())
    })
)
