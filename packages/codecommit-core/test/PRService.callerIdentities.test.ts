import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema, SubscriptionRef } from "effect"
import { AwsClient } from "../src/AwsClient/index.js"
import { NotificationRepo } from "../src/CacheService/repos/NotificationRepo.js"
import { PullRequestRepo } from "../src/CacheService/repos/PullRequestRepo/index.js"
import { SubscriptionRepo } from "../src/CacheService/repos/SubscriptionRepo.js"
import { ConfigService } from "../src/ConfigService/index.js"
import { TuiConfig } from "../src/ConfigService/internal.js"
import { type AppState, AwsProfileName, AwsRegion } from "../src/Domain.js"
import { AwsApiError, AwsCredentialError, AwsThrottleError } from "../src/Errors.js"
import { resolveAccounts } from "../src/PRService/refreshResolve.js"

const region = Schema.decodeSync(AwsRegion)("us-east-1")
const profile = Schema.decodeSync(AwsProfileName)

const config = Schema.decodeSync(TuiConfig)({
  accounts: ["alpha", "beta", "gamma", "delta"].map((name) => ({
    profile: name,
    regions: ["us-east-1"],
    enabled: true
  }))
})

/** Four accounts: one resolves, the others fail with each error STS lookups can fail with. */
const accounts = Layer.mergeAll(
  Layer.mock(AwsClient, {
    getCallerIdentity: (account) => {
      switch (account.profile) {
        case "alpha":
          return Effect.succeed({
            accountId: "111111111111",
            arn: "arn:aws:sts::111111111111:assumed-role/Reviewers/alice@example.com",
            username: "alice@example.com"
          })
        case "beta":
          return Effect.fail(new AwsCredentialError({ profile: account.profile, region, cause: "sso expired" }))
        case "gamma":
          return Effect.fail(
            new AwsApiError({ operation: "getCallerIdentity", profile: account.profile, region, cause: "denied" })
          )
        default:
          return Effect.fail(
            new AwsThrottleError({ operation: "getCallerIdentity", retryCount: 5, cause: "slow down" })
          )
      }
    }
  }),
  Layer.mock(NotificationRepo, { addSystem: () => Effect.void }),
  Layer.mock(PullRequestRepo, { findAll: () => Effect.succeed([]) }),
  Layer.mock(SubscriptionRepo, { findAll: () => Effect.succeed([]) }),
  Layer.mock(ConfigService, { load: Effect.succeed(config), detectProfiles: Effect.succeed([]) })
)

describe("resolveAccounts caller identities", () => {
  it.layer(accounts)((it) => {
    it.effect("publishes every enabled account's identity, and why it is unknown where it failed", () =>
      Effect.gen(function*() {
        const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "idle" })
        yield* resolveAccounts(state)
        const { callerIdentities } = yield* SubscriptionRef.get(state)
        expect(callerIdentities).toEqual({
          [profile("alpha")]: {
            _tag: "Resolved",
            accountId: "111111111111",
            arn: "arn:aws:sts::111111111111:assumed-role/Reviewers/alice@example.com",
            username: "alice@example.com"
          },
          [profile("beta")]: { _tag: "Unresolved", reason: { _tag: "CredentialsUnavailable" } },
          [profile("gamma")]: { _tag: "Unresolved", reason: { _tag: "StsRejected" } },
          [profile("delta")]: { _tag: "Unresolved", reason: { _tag: "Throttled" } }
        })
      }))
  })
})
