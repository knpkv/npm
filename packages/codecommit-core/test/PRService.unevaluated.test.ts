import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema, SubscriptionRef } from "effect"
import { AwsClient } from "../src/AwsClient/index.js"
import { NotificationRepo } from "../src/CacheService/repos/NotificationRepo.js"
import { PullRequestRepo } from "../src/CacheService/repos/PullRequestRepo/index.js"
import { SubscriptionRepo } from "../src/CacheService/repos/SubscriptionRepo.js"
import { ConfigService } from "../src/ConfigService/index.js"
import { TuiConfig } from "../src/ConfigService/internal.js"
import { type AppState, AwsProfileName, AwsRegion } from "../src/Domain.js"
import { resolveAccounts } from "../src/PRService/refreshResolve.js"

/** Every account switched off: a refresh has nothing to fetch. */
const noEnabledAccounts = Layer.mergeAll(
  Layer.mock(AwsClient, {}),
  Layer.mock(NotificationRepo, {}),
  Layer.mock(PullRequestRepo, { findAll: () => Effect.succeed([]) }),
  Layer.mock(SubscriptionRepo, { findAll: () => Effect.succeed([]) }),
  Layer.mock(ConfigService, {
    load: Effect.succeed(
      Schema.decodeSync(TuiConfig)({ accounts: [{ profile: "alpha", regions: ["us-east-1"], enabled: false }] })
    ),
    detectProfiles: Effect.succeed([])
  })
)

describe("unevaluated pull requests", () => {
  it.layer(noEnabledAccounts)((it) => {
    it.effect("clears the last refresh's unevaluated pull requests when no account is enabled", () =>
      Effect.gen(function*() {
        const state = yield* SubscriptionRef.make<AppState>({
          pullRequests: [],
          accounts: [],
          status: "idle",
          unevaluatedPullRequests: [{
            profile: Schema.decodeSync(AwsProfileName)("alpha"),
            region: Schema.decodeSync(AwsRegion)("us-east-1"),
            pullRequestId: "8",
            repositoryName: "repo",
            message: "EvaluatePullRequestApprovalRules failed for pull request 8: denied"
          }]
        })
        yield* resolveAccounts(state)
        expect((yield* SubscriptionRef.get(state)).unevaluatedPullRequests).toEqual([])
      }))
  })
})
