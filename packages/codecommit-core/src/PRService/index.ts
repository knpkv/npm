/**
 * Pull request orchestration service.
 *
 * @category Service
 * @module
 */
import { Context, Effect, Layer, Option, Semaphore, SubscriptionRef } from "effect"
import type { Success } from "effect/Effect"
import { AwsClient } from "../AwsClient/index.js"
import { EventsHub } from "../CacheService/EventsHub.js"
import { CommentRepo } from "../CacheService/repos/CommentRepo.js"
import { NotificationRepo } from "../CacheService/repos/NotificationRepo.js"
import type { PaginatedNotifications } from "../CacheService/repos/NotificationRepo.js"
import type { CachedPullRequest, SearchResult } from "../CacheService/repos/PullRequestRepo/index.js"
import { PullRequestRepo } from "../CacheService/repos/PullRequestRepo/index.js"
import { SubscriptionRepo } from "../CacheService/repos/SubscriptionRepo.js"
import { SyncMetadataRepo } from "../CacheService/repos/SyncMetadataRepo.js"
import { ConfigService } from "../ConfigService/index.js"
import type { AppState, AwsProfileName, PRCommentLocation, PullRequestId } from "../Domain.js"
import { decodeCachedPR } from "./internal.js"
import { makeRefresh, type RefreshDeps } from "./refresh.js"
import { makeRefreshSinglePR } from "./refreshSinglePR.js"
import { makeSetAllAccounts } from "./setAllAccounts.js"
import { makeToggleAccount } from "./toggleAccount.js"

export type { SearchResult } from "../CacheService/repos/PullRequestRepo/index.js"
export { CachedPRToPullRequest, decodeCachedPR, PullRequestToUpsertInput } from "./internal.js"

// ---------------------------------------------------------------------------
// Service Definition
// ---------------------------------------------------------------------------

const makePRService = Effect.gen(function*() {
  const configService = yield* ConfigService
  const awsClient = yield* AwsClient
  const prRepo = yield* PullRequestRepo
  const commentRepo = yield* CommentRepo
  const notificationRepo = yield* NotificationRepo
  const subscriptionRepo = yield* SubscriptionRepo
  const syncMetadataRepo = yield* SyncMetadataRepo
  const eventsHub = yield* EventsHub

  const provide = <A, E>(effect: Effect.Effect<A, E, RefreshDeps>): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(ConfigService, configService),
      Effect.provideService(AwsClient, awsClient),
      Effect.provideService(PullRequestRepo, prRepo),
      Effect.provideService(CommentRepo, commentRepo),
      Effect.provideService(NotificationRepo, notificationRepo),
      Effect.provideService(SubscriptionRepo, subscriptionRepo),
      Effect.provideService(SyncMetadataRepo, syncMetadataRepo),
      Effect.provideService(EventsHub, eventsHub)
    )

  // Load cached PRs to show immediately
  const cachedPRs = yield* prRepo.findAll().pipe(Effect.catchCause(() => Effect.succeed<Array<CachedPullRequest>>([])))

  const state = yield* SubscriptionRef.make<AppState>({
    pullRequests: cachedPRs.map((pr) => decodeCachedPR(pr)),
    accounts: [],
    status: "idle"
  })

  const refreshSem = yield* Semaphore.make(1)
  const refreshEffect: Effect.Effect<void, never, RefreshDeps> = makeRefresh(state)
  const refresh: Effect.Effect<void> = refreshSem.withPermits(1)(provide(refreshEffect))
  const toggleAccount = makeToggleAccount(refresh)
  const setAllAccounts = makeSetAllAccounts(refresh)
  const refreshSinglePR = makeRefreshSinglePR(state)

  return {
    state,
    refresh,
    toggleAccount: (profile: AwsProfileName) => provide(toggleAccount(profile)),
    setAllAccounts: (enabled: boolean, profiles?: Array<AwsProfileName>) => provide(setAllAccounts(enabled, profiles)),
    // Cache delegates – absorb CacheError at the PRService boundary
    searchPullRequests: (
      query: string,
      opts?: { readonly limit?: number; readonly offset?: number }
    ) =>
      prRepo.search(query, opts).pipe(
        Effect.tapError((e) => Effect.logWarning("PRService.searchPullRequests", e)),
        Effect.catchCause(() => Effect.succeed<SearchResult>({ items: [], total: 0, hasMore: false }))
      ),
    subscribe: (awsAccountId: string, prId: PullRequestId) =>
      subscriptionRepo.subscribe(awsAccountId, prId).pipe(Effect.catchCause(() => Effect.void)),
    unsubscribe: (awsAccountId: string, prId: PullRequestId) =>
      subscriptionRepo.unsubscribe(awsAccountId, prId).pipe(Effect.catchCause(() => Effect.void)),
    getSubscriptions: () =>
      subscriptionRepo.findAll().pipe(
        Effect.catchCause(() => Effect.succeed<ReadonlyArray<{ awsAccountId: string; pullRequestId: string }>>([]))
      ),
    isSubscribed: (awsAccountId: string, prId: PullRequestId) =>
      subscriptionRepo.isSubscribed(awsAccountId, prId).pipe(Effect.catchCause(() => Effect.succeed(false))),
    getPersistentNotifications: (
      opts?: { readonly unreadOnly?: boolean; readonly limit?: number; readonly cursor?: number }
    ) =>
      notificationRepo.findAll(opts).pipe(
        Effect.catchCause(() => Effect.succeed<PaginatedNotifications>({ items: [] }))
      ),
    markNotificationRead: (id: number) => notificationRepo.markRead(id).pipe(Effect.catchCause(() => Effect.void)),
    markAllNotificationsRead: () => notificationRepo.markAllRead().pipe(Effect.catchCause(() => Effect.void)),
    getUnreadNotificationCount: () => notificationRepo.unreadCount().pipe(Effect.catchCause(() => Effect.succeed(0))),
    getCachedComments: (awsAccountId: string, prId: PullRequestId) =>
      commentRepo.find(awsAccountId, prId).pipe(
        Effect.catchCause(() => Effect.succeed(Option.none<ReadonlyArray<PRCommentLocation>>()))
      ),
    refreshSinglePR: (awsAccountId: string, prId: PullRequestId) => provide(refreshSinglePR(awsAccountId, prId))
  }
})

export interface PRServiceShape extends Success<typeof makePRService> {}

export class PRService extends Context.Service<
  PRService,
  PRServiceShape
>()("@knpkv/codecommit-core/PRService") {
  static readonly Default = Layer.effect(PRService, makePRService)
}

// Module-level alias for namespace consumers (barrel uses `export * as PRService`)
export const PRServiceLive = PRService.Default
