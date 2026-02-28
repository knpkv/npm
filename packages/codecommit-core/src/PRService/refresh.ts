/**
 * @internal
 */

import { Cause, Clock, DateTime, Effect, SubscriptionRef } from "effect"
import type { AwsClient } from "../AwsClient/index.js"
import { EventsHub } from "../CacheService/EventsHub.js"
import type { CommentRepo } from "../CacheService/repos/CommentRepo.js"
import type { NotificationRepo } from "../CacheService/repos/NotificationRepo.js"
import type { PullRequestRepo } from "../CacheService/repos/PullRequestRepo.js"
import type { SubscriptionRepo } from "../CacheService/repos/SubscriptionRepo.js"
import { SyncMetadataRepo } from "../CacheService/repos/SyncMetadataRepo.js"
import type { ConfigService } from "../ConfigService/index.js"
import type { PRState } from "./internal.js"
import { enrichComments } from "./refreshEnrich.js"
import { fetchAndUpsertPRs } from "./refreshFetch.js"
import { resolveAccounts } from "./refreshResolve.js"
import { calculateHealthScores } from "./refreshScore.js"

export type RefreshDeps =
  | ConfigService
  | AwsClient
  | PullRequestRepo
  | CommentRepo
  | NotificationRepo
  | SubscriptionRepo
  | SyncMetadataRepo
  | EventsHub

export const makeRefresh = Effect.fn("PRService.refresh")(
  function*(state: PRState) {
    const hub = yield* EventsHub
    const syncMetadataRepo = yield* SyncMetadataRepo

    const resolved = yield* resolveAccounts(state)
    if (!resolved) return

    const { accountIdMap, currentUser, enabledAccounts, subscribedRef } = resolved
    const staleNow = yield* Clock.currentTimeMillis
    const staleThreshold = DateTime.toDate(DateTime.unsafeMake(staleNow)).toISOString().slice(0, 19) + "Z"

    yield* hub.batch(
      Effect.gen(function*() {
        yield* fetchAndUpsertPRs({ state, enabledAccounts, accountIdMap, subscribedRef, currentUser, staleThreshold })
        yield* enrichComments({ state, subscribedRef })
        yield* calculateHealthScores(state)
      })
    )

    // Set idle
    const now = yield* Clock.currentTimeMillis
    yield* SubscriptionRef.update(state, ({ statusDetail: _, ...s }) => ({
      ...s,
      status: "idle" as const,
      lastUpdated: DateTime.toDate(DateTime.unsafeMake(now))
    }))

    // Sync metadata
    yield* Effect.forEach(
      enabledAccounts,
      (account) => {
        const awsAccountId = accountIdMap.get(account.profile) ?? account.profile
        return Effect.forEach(
          account.regions ?? [],
          (region) => syncMetadataRepo.update(awsAccountId, region),
          { discard: true }
        )
      },
      { discard: true }
    ).pipe(Effect.catchAll(() => Effect.void))
  },
  (effect, state) =>
    effect.pipe(
      Effect.timeout("120 seconds"),
      Effect.catchAllCause((cause) => {
        const squashed = Cause.squash(cause)
        const errorStr = (squashed instanceof Error ? squashed.message : String(squashed)) || "Unknown error"
        return SubscriptionRef.update(state, (s) => ({ ...s, status: "error" as const, error: errorStr }))
      })
    )
)
