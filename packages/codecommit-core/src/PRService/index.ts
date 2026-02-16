/**
 * Pull request orchestration service.
 *
 * @category Service
 * @module
 */
import type { Option } from "effect"
import { Context, Effect, Layer, SubscriptionRef } from "effect"
import type { AwsClient } from "../AwsClient/index.js"
import type { EventsHub } from "../CacheService/EventsHub.js"
import { CommentRepo } from "../CacheService/repos/CommentRepo.js"
import { NotificationRepo } from "../CacheService/repos/NotificationRepo.js"
import type { PaginatedNotifications } from "../CacheService/repos/NotificationRepo.js"
import type { SearchResult } from "../CacheService/repos/PullRequestRepo.js"
import { PullRequestRepo } from "../CacheService/repos/PullRequestRepo.js"
import { SubscriptionRepo } from "../CacheService/repos/SubscriptionRepo.js"
import type { SyncMetadataRepo } from "../CacheService/repos/SyncMetadataRepo.js"
import type { ConfigService } from "../ConfigService/index.js"
import type { AppState, AwsProfileName, PRCommentLocation, PullRequestId } from "../Domain.js"
import { decodeCachedPR } from "./internal.js"
import { makeRefresh } from "./refresh.js"
import { makeRefreshSinglePR } from "./refreshSinglePR.js"
import { makeSetAllAccounts } from "./setAllAccounts.js"
import { makeToggleAccount } from "./toggleAccount.js"

export type { SearchResult } from "../CacheService/repos/PullRequestRepo.js"
export { CachedPRToPullRequest, decodeCachedPR, PullRequestToUpsertInput } from "./internal.js"

// ---------------------------------------------------------------------------
// Service Definition
// ---------------------------------------------------------------------------

export class PRService extends Context.Tag("@knpkv/codecommit-core/PRService")<
  PRService,
  {
    readonly state: SubscriptionRef.SubscriptionRef<AppState>
    readonly refresh: Effect.Effect<void>
    readonly toggleAccount: (profile: AwsProfileName) => Effect.Effect<void>
    readonly setAllAccounts: (
      enabled: boolean,
      profiles?: Array<AwsProfileName>
    ) => Effect.Effect<void>
    // Cache methods
    readonly searchPullRequests: (
      query: string,
      opts?: { readonly limit?: number; readonly offset?: number }
    ) => Effect.Effect<SearchResult>
    readonly subscribe: (awsAccountId: string, prId: PullRequestId) => Effect.Effect<void>
    readonly unsubscribe: (awsAccountId: string, prId: PullRequestId) => Effect.Effect<void>
    readonly getSubscriptions: () => Effect.Effect<ReadonlyArray<{ awsAccountId: string; pullRequestId: string }>>
    readonly isSubscribed: (awsAccountId: string, prId: PullRequestId) => Effect.Effect<boolean>
    readonly getPersistentNotifications: (
      opts?: { readonly unreadOnly?: boolean; readonly limit?: number; readonly cursor?: number }
    ) => Effect.Effect<PaginatedNotifications>
    readonly markNotificationRead: (id: number) => Effect.Effect<void>
    readonly markAllNotificationsRead: () => Effect.Effect<void>
    readonly getUnreadNotificationCount: () => Effect.Effect<number>
    readonly getCachedComments: (
      awsAccountId: string,
      prId: PullRequestId
    ) => Effect.Effect<Option.Option<ReadonlyArray<PRCommentLocation>>>
    readonly refreshSinglePR: (awsAccountId: string, prId: PullRequestId) => Effect.Effect<void>
  }
>() {}

// ---------------------------------------------------------------------------
// Live Implementation
// ---------------------------------------------------------------------------

export const PRServiceLive = Layer.effect(
  PRService,
  Effect.gen(function*() {
    const prRepo = yield* PullRequestRepo
    const commentRepo = yield* CommentRepo
    const notificationRepo = yield* NotificationRepo
    const subscriptionRepo = yield* SubscriptionRepo

    const ctx = yield* Effect.context<
      | ConfigService
      | AwsClient
      | PullRequestRepo
      | CommentRepo
      | NotificationRepo
      | SubscriptionRepo
      | SyncMetadataRepo
      | EventsHub
    >()

    // Load cached PRs to show immediately
    const cachedPRs = yield* prRepo.findAll().pipe(Effect.catchAll(() => Effect.succeed([])))

    const state = yield* SubscriptionRef.make<AppState>({
      pullRequests: cachedPRs.map(decodeCachedPR),
      accounts: [],
      status: "idle"
    })

    const provide = <A, E>(effect: Effect.Effect<A, E, typeof ctx extends Context.Context<infer R> ? R : never>) =>
      Effect.provide(effect, ctx)

    const refreshSem = yield* Effect.makeSemaphore(1)
    const refresh = refreshSem.withPermits(1)(provide(makeRefresh(state)))
    const toggleAccount = makeToggleAccount(state, refresh)
    const setAllAccounts = makeSetAllAccounts(state, refresh)
    const refreshSinglePR = makeRefreshSinglePR(state)

    return {
      state,
      refresh,
      toggleAccount: (p) => provide(toggleAccount(p)),
      setAllAccounts: (e, ps) => provide(setAllAccounts(e, ps)),
      // Cache delegates
      searchPullRequests: (query, opts) => prRepo.search(query, opts),
      subscribe: (awsAccountId, prId) => subscriptionRepo.subscribe(awsAccountId, prId),
      unsubscribe: (awsAccountId, prId) => subscriptionRepo.unsubscribe(awsAccountId, prId),
      getSubscriptions: () => subscriptionRepo.findAll(),
      isSubscribed: (awsAccountId, prId) => subscriptionRepo.isSubscribed(awsAccountId, prId),
      getPersistentNotifications: (opts) => notificationRepo.findAll(opts),
      markNotificationRead: (id) => notificationRepo.markRead(id),
      markAllNotificationsRead: () => notificationRepo.markAllRead(),
      getUnreadNotificationCount: () => notificationRepo.unreadCount(),
      getCachedComments: (awsAccountId, prId) => commentRepo.find(awsAccountId, prId),
      refreshSinglePR: (awsAccountId, prId) => provide(refreshSinglePR(awsAccountId, prId))
    }
  })
)
