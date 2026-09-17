/**
 * @internal
 */

import { Clock, DateTime, Effect, Option, Predicate, Result, SubscriptionRef } from "effect"
import type { AwsClient } from "../AwsClient/index.js"
import type { CacheError } from "../CacheService/CacheError.js"
import { EventsHub } from "../CacheService/EventsHub.js"
import type { CommentRepo } from "../CacheService/repos/CommentRepo.js"
import type { NotificationRepo } from "../CacheService/repos/NotificationRepo.js"
import { PullRequestRepo } from "../CacheService/repos/PullRequestRepo/index.js"
import type { SubscriptionRepo } from "../CacheService/repos/SubscriptionRepo.js"
import { SyncMetadataRepo } from "../CacheService/repos/SyncMetadataRepo.js"
import type { ConfigService } from "../ConfigService/index.js"
import type { AppStatus } from "../Domain.js"
import { decodeCachedPR, type PRState } from "./internal.js"
import { enrichDiffs } from "./refreshDiffs.js"
import { enrichComments } from "./refreshEnrich.js"
import { fetchAndUpsertPRs } from "./refreshFetch.js"
import { resolveAccounts } from "./refreshResolve.js"
import { calculateHealthScores } from "./refreshScore.js"
import { currentEnabledProfiles, retainEnabledAccountRows, staleListMessage } from "./visibility.js"

const idleStatus: AppStatus = "idle"
const errorStatus: AppStatus = "error"

const refreshErrorMessage = <UnparsedInput>(error: UnparsedInput): string =>
  Result.try(() => String(Predicate.isError(error) ? error.message : error) || "Unknown error").pipe(
    Result.getOrElse(() => "Unknown error")
  )

const transitionToRefreshError = <UnparsedInput>(state: PRState, error: UnparsedInput) =>
  SubscriptionRef.update(state, (current) => ({
    ...current,
    status: errorStatus,
    error: refreshErrorMessage(error)
  }))

/**
 * Publishes the freshly enriched cache, and reports whether it got there.
 *
 * Enablement is re-read here rather than reused from the refresh's opening
 * snapshot: a toggle during a long refresh saves the config and then queues
 * behind the refresh semaphore, so the captured set would republish rows the
 * user has already switched off. When it cannot be read at all, nothing is
 * published — the last correctly filtered list stands.
 */
const publishCachedPullRequests = (
  state: PRState
): Effect.Effect<boolean, CacheError, PullRequestRepo | ConfigService> =>
  Effect.gen(function*() {
    const prRepo = yield* PullRequestRepo
    const rows = yield* prRepo.findAll()
    // After the cache read, so a toggle during a slow read still applies.
    const enabled = yield* currentEnabledProfiles
    if (Option.isNone(enabled)) return false
    const pullRequests = retainEnabledAccountRows(rows, enabled.value).map((row) => decodeCachedPR(row))
    yield* SubscriptionRef.update(state, (current) => ({ ...current, pullRequests }))
    return true
  })

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
    if (resolved === undefined) return

    const { accountIdMap, currentUser, enabledAccounts, subscribedRef } = resolved
    const staleNow = yield* Clock.currentTimeMillis
    const staleThreshold = DateTime.toDate(DateTime.makeUnsafe(staleNow)).toISOString().slice(0, 19) + "Z"

    const { published, scopes: successfulRefreshScopes } = yield* hub.batch(
      Effect.gen(function*() {
        const scopes = yield* fetchAndUpsertPRs({
          state,
          enabledAccounts,
          accountIdMap,
          subscribedRef,
          currentUser,
          staleThreshold
        })
        yield* enrichComments({ state, subscribedRef })
        yield* enrichDiffs(state)
        yield* calculateHealthScores(state)
        // All enrichment writes land in the cache. Publish that final snapshot
        // during this refresh so newly fetched PRs do not require a second run.
        const published = yield* publishCachedPullRequests(state)
        return { published, scopes }
      })
    )

    // A refresh that could not publish is not a successful one: it keeps neither
    // the fresh timestamp nor the scope list, and says why, rather than
    // reporting a list the user is not looking at.
    const now = yield* Clock.currentTimeMillis
    yield* SubscriptionRef.update(state, ({ statusDetail: _, ...s }) => ({
      ...s,
      status: idleStatus,
      ...(published
        ? { lastUpdated: DateTime.toDate(DateTime.makeUnsafe(now)), successfulRefreshScopes }
        : { error: staleListMessage })
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
    ).pipe(Effect.catchIf(() => true, () => Effect.void))
  },
  (effect, state) =>
    effect.pipe(
      Effect.timeout("120 seconds"),
      Effect.catch((error) => transitionToRefreshError(state, error)),
      Effect.tapDefect((defect) =>
        Effect.logError("PRService.refresh defect", defect).pipe(
          Effect.andThen(transitionToRefreshError(state, defect))
        )
      )
    )
)
