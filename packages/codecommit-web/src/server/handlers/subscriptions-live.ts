import { CacheService, PRService } from "@knpkv/codecommit-core"
import { Effect, Option, Predicate } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiError, CodeCommitApi } from "../Api.js"

export const SubscriptionsLive = HttpApiBuilder.group(
  CodeCommitApi,
  "subscriptions",
  (handlers) =>
    Effect.gen(function*() {
      const prService = yield* PRService.PRService
      const pullRequestRepo = yield* CacheService.PullRequestRepo
      const subscriptionRepo = yield* CacheService.SubscriptionRepo

      const exactCoordinates = (payload: {
        readonly awsAccountId: string
        readonly pullRequestId: string
        readonly repositoryName?: string | undefined
        readonly region?: string | undefined
      }): Effect.Effect<{ readonly repositoryName: string; readonly accountRegion: string }, ApiError> => {
        if (payload.repositoryName !== undefined && payload.region !== undefined) {
          return Effect.succeed({
            repositoryName: String(payload.repositoryName),
            accountRegion: String(payload.region)
          })
        }
        return pullRequestRepo.findByAccountAndId(payload.awsAccountId, payload.pullRequestId).pipe(
          Effect.flatMap(Option.match({
            onNone: () => Effect.fail(new ApiError({ message: "The pull request is not available for subscription" })),
            onSome: (row) =>
              Effect.succeed({
                repositoryName: String(row.repositoryName),
                accountRegion: String(row.accountRegion)
              })
          })),
          Effect.mapError((error) =>
            Predicate.isTagged(error, "ApiError")
              ? error
              : Predicate.isTagged(error, "PullRequestAmbiguityError")
              ? new ApiError({ message: "Subscription coordinates are required for an ambiguous pull request" })
              : new ApiError({ message: `Subscription lookup failed: ${String(error)}` })
          )
        )
      }

      return handlers
        .handle("subscribe", ({ payload }) =>
          exactCoordinates(payload).pipe(
            Effect.flatMap((coordinates) =>
              subscriptionRepo.subscribe(payload.awsAccountId, payload.pullRequestId, coordinates)
            ),
            Effect.map(() => "ok"),
            Effect.mapError((e) => new ApiError({ message: `Subscription failed: ${String(e)}` }))
          ))
        .handle("unsubscribe", ({ payload }) =>
          exactCoordinates(payload).pipe(
            Effect.flatMap((coordinates) =>
              subscriptionRepo.unsubscribe(payload.awsAccountId, payload.pullRequestId, coordinates)
            ),
            Effect.map(() => "ok"),
            Effect.mapError((e) => new ApiError({ message: `Subscription failed: ${String(e)}` }))
          ))
        .handle("list", () => prService.getSubscriptions())
    })
)
