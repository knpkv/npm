/**
 * Pull request orchestration service.
 *
 * @category Service
 * @module
 */
import { Effect, Layer, Option, SubscriptionRef } from "effect"
import { AwsClient } from "../AwsClient/index.js"
import { EventsHub } from "../CacheService/EventsHub.js"
import { CommentRepo } from "../CacheService/repos/CommentRepo.js"
import { NotificationRepo } from "../CacheService/repos/NotificationRepo.js"
import type { PaginatedNotifications } from "../CacheService/repos/NotificationRepo.js"
import type { SearchResult } from "../CacheService/repos/PullRequestRepo.js"
import { PullRequestRepo } from "../CacheService/repos/PullRequestRepo.js"
import { SubscriptionRepo } from "../CacheService/repos/SubscriptionRepo.js"
import { SyncMetadataRepo } from "../CacheService/repos/SyncMetadataRepo.js"
import { ConfigService } from "../ConfigService/index.js"
import type { AppState, AwsProfileName, PRCommentLocation, PullRequestId } from "../Domain.js"
import { decodeCachedPR } from "./internal.js"
import { makeRefresh, type RefreshDeps } from "./refresh.js"
import { makeRefreshSinglePR } from "./refreshSinglePR.js"
import { makeSetAllAccounts } from "./setAllAccounts.js"
import { makeToggleAccount } from "./toggleAccount.js"

export type { SearchResult } from "../CacheService/repos/PullRequestRepo.js"
export { CachedPRToPullRequest, decodeCachedPR, PullRequestToUpsertInput } from "./internal.js"

// ---------------------------------------------------------------------------
// Service Definition
// ---------------------------------------------------------------------------

export class PRService extends Effect.Service<PRService>()("@knpkv/codecommit-core/PRService", {
  effect: Effect.gen(function*() {
    const configService = yield* ConfigService
    const awsClient = yield* AwsClient
    const prRepo = yield* PullRequestRepo
    const commentRepo = yield* CommentRepo
    const notificationRepo = yield* NotificationRepo
    const subscriptionRepo = yield* SubscriptionRepo
    const syncMetadataRepo = yield* SyncMetadataRepo
    const eventsHub = yield* EventsHub

    const depsLayer = Layer.mergeAll(
      Layer.succeed(ConfigService, configService),
      Layer.succeed(AwsClient, awsClient),
      Layer.succeed(PullRequestRepo, prRepo),
      Layer.succeed(CommentRepo, commentRepo),
      Layer.succeed(NotificationRepo, notificationRepo),
      Layer.succeed(SubscriptionRepo, subscriptionRepo),
      Layer.succeed(SyncMetadataRepo, syncMetadataRepo),
      Layer.succeed(EventsHub, eventsHub)
    )

    const provide = <A, E>(effect: Effect.Effect<A, E, RefreshDeps>) => Effect.provide(effect, depsLayer)

    // Load cached PRs to show immediately
    const cachedPRs = yield* prRepo.findAll().pipe(Effect.catchAll(() => Effect.succeed([])))

    const state = yield* SubscriptionRef.make<AppState>({
      pullRequests: cachedPRs.map(decodeCachedPR),
      accounts: [],
      status: "idle"
    })

    const refreshSem = yield* Effect.makeSemaphore(1)
    const refresh = refreshSem.withPermits(1)(provide(makeRefresh(state)))
    const toggleAccount = makeToggleAccount(refresh)
    const setAllAccounts = makeSetAllAccounts(refresh)
    const refreshSinglePR = makeRefreshSinglePR(state)

    return {
      state,
      refresh,
      toggleAccount: (profile: AwsProfileName) => provide(toggleAccount(profile)),
      setAllAccounts: (enabled: boolean, profiles?: Array<AwsProfileName>) =>
        provide(setAllAccounts(enabled, profiles)),
      // Cache delegates – absorb CacheError at the PRService boundary
      searchPullRequests: (
        query: string,
        opts?: { readonly limit?: number; readonly offset?: number }
      ) =>
        prRepo.search(query, opts).pipe(
          Effect.tapError((e) => Effect.logWarning("PRService.searchPullRequests", e)),
          Effect.catchAll(() => Effect.succeed<SearchResult>({ items: [], total: 0, hasMore: false }))
        ),
      subscribe: (awsAccountId: string, prId: PullRequestId) =>
        subscriptionRepo.subscribe(awsAccountId, prId).pipe(Effect.catchAll(() => Effect.void)),
      unsubscribe: (awsAccountId: string, prId: PullRequestId) =>
        subscriptionRepo.unsubscribe(awsAccountId, prId).pipe(Effect.catchAll(() => Effect.void)),
      getSubscriptions: () =>
        subscriptionRepo.findAll().pipe(
          Effect.catchAll(() => Effect.succeed<ReadonlyArray<{ awsAccountId: string; pullRequestId: string }>>([]))
        ),
      isSubscribed: (awsAccountId: string, prId: PullRequestId) =>
        subscriptionRepo.isSubscribed(awsAccountId, prId).pipe(Effect.catchAll(() => Effect.succeed(false))),
      getPersistentNotifications: (
        opts?: { readonly unreadOnly?: boolean; readonly limit?: number; readonly cursor?: number }
      ) =>
        notificationRepo.findAll(opts).pipe(
          Effect.catchAll(() => Effect.succeed<PaginatedNotifications>({ items: [] }))
        ),
      markNotificationRead: (id: number) => notificationRepo.markRead(id).pipe(Effect.catchAll(() => Effect.void)),
      markAllNotificationsRead: () => notificationRepo.markAllRead().pipe(Effect.catchAll(() => Effect.void)),
      getUnreadNotificationCount: () => notificationRepo.unreadCount().pipe(Effect.catchAll(() => Effect.succeed(0))),
      getCachedComments: (awsAccountId: string, prId: PullRequestId) =>
        commentRepo.find(awsAccountId, prId).pipe(
          Effect.catchAll(() => Effect.succeed(Option.none<ReadonlyArray<PRCommentLocation>>()))
        ),
      refreshSinglePR: (awsAccountId: string, prId: PullRequestId) => provide(refreshSinglePR(awsAccountId, prId))
    }
  })
}) {}

// Module-level alias for namespace consumers (barrel uses `export * as PRService`)
export const PRServiceLive = PRService.Default
