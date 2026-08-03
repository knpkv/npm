import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Ref, Schema, Stream, SubscriptionRef } from "effect"
import { AwsClient } from "../src/AwsClient/index.js"
import { NotificationRepo } from "../src/CacheService/repos/NotificationRepo.js"
import { PullRequestRepo } from "../src/CacheService/repos/PullRequestRepo/index.js"
import { SubscriptionRepo } from "../src/CacheService/repos/SubscriptionRepo.js"
import { AccountConfig } from "../src/ConfigService/internal.js"
import type { AppState } from "../src/Domain.js"
import { fetchAndUpsertPRs } from "../src/PRService/refreshFetch.js"

describe("fetchAndUpsertPRs", () => {
  it.effect("preserves the original interruption from an account stream", () =>
    Effect.gen(function*() {
      const interruption = Cause.interrupt(734)
      const state = yield* SubscriptionRef.make<AppState>({
        pullRequests: [],
        accounts: [],
        status: "loading"
      })
      const subscribedRef = yield* Ref.make(new Set<string>())
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getPullRequests: () => Stream.fromEffect(Effect.failCause(interruption))
        }),
        Layer.mock(PullRequestRepo, {}),
        Layer.mock(NotificationRepo, {}),
        Layer.mock(SubscriptionRepo, {})
      )

      const exit = yield* fetchAndUpsertPRs({
        state,
        enabledAccounts: [account],
        accountIdMap: new Map([["test-profile", "123456789012"]]),
        subscribedRef,
        currentUser: undefined,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(
        Effect.provide(dependencies),
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons).toEqual(interruption.reasons)
      }
    }))
})
