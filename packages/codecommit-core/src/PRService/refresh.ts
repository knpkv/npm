/**
 * @internal
 */

import { Cause, Clock, DateTime, Effect, Option, Stream, SubscriptionRef } from "effect"
import { AwsClient } from "../AwsClient/index.js"
import { diffComments, diffPR } from "../CacheService/diff.js"
import { CommentRepo } from "../CacheService/repos/CommentRepo.js"
import { NotificationRepo } from "../CacheService/repos/NotificationRepo.js"
import type { UpsertInput } from "../CacheService/repos/PullRequestRepo.js"
import { PullRequestRepo } from "../CacheService/repos/PullRequestRepo.js"
import { SubscriptionRepo } from "../CacheService/repos/SubscriptionRepo.js"
import { SyncMetadataRepo } from "../CacheService/repos/SyncMetadataRepo.js"
import { ConfigService } from "../ConfigService/index.js"
import { Account, type AwsRegion, type CommentThread, type PRCommentLocation, PullRequest } from "../Domain.js"
import { NotificationsService } from "../NotificationsService.js"
import type { PRState } from "./internal.js"

const countThreadComments = (thread: CommentThread): number =>
  1 + thread.replies.reduce((sum, r) => sum + countThreadComments(r), 0)

const countAllComments = (locations: ReadonlyArray<PRCommentLocation>): number =>
  locations.reduce(
    (sum, loc) => sum + loc.comments.reduce((s, t) => s + countThreadComments(t), 0),
    0
  )

const prToUpsertInput = (pr: PullRequest, awsAccountId: string): UpsertInput => ({
  id: pr.id,
  awsAccountId,
  accountProfile: pr.account.profile,
  accountRegion: pr.account.region,
  title: pr.title,
  description: pr.description ?? null,
  author: pr.author,
  repositoryName: pr.repositoryName,
  creationDate: pr.creationDate.toISOString(),
  lastModifiedDate: pr.lastModifiedDate.toISOString(),
  status: pr.status,
  sourceBranch: pr.sourceBranch,
  destinationBranch: pr.destinationBranch,
  isMergeable: pr.isMergeable ? 1 : 0,
  isApproved: pr.isApproved ? 1 : 0,
  commentCount: pr.commentCount ?? null,
  link: pr.link
})

export type RefreshDeps =
  | ConfigService
  | AwsClient
  | NotificationsService
  | PullRequestRepo
  | CommentRepo
  | NotificationRepo
  | SubscriptionRepo
  | SyncMetadataRepo

export const makeRefresh = (
  state: PRState
): Effect.Effect<void, never, RefreshDeps> =>
  Effect.gen(function*() {
    const configService = yield* ConfigService
    const awsClient = yield* AwsClient
    const notificationsService = yield* NotificationsService
    const prRepo = yield* PullRequestRepo
    const commentRepo = yield* CommentRepo
    const notificationRepo = yield* NotificationRepo
    const subscriptionRepo = yield* SubscriptionRepo
    const syncMetadataRepo = yield* SyncMetadataRepo

    // --- Phase 1: Load cached PRs immediately ---
    const cachedPRs = yield* prRepo.findAll().pipe(Effect.catchAll(() => Effect.succeed([])))

    yield* SubscriptionRef.update(state, (s) => ({
      ...s,
      status: "loading" as const,
      statusDetail: cachedPRs.length > 0 ? "loading from cache..." : undefined,
      error: undefined
    }))

    yield* notificationsService.clear

    const config = yield* configService.load.pipe(
      Effect.catchAll((e) => Effect.fail(new Error(`Config load failed: ${e.message}`)))
    )

    const detected = yield* configService.detectProfiles.pipe(Effect.catchAll(() => Effect.succeed([])))

    const accountsState = detected.map((d) => {
      const configured = config.accounts.find((a) => a.profile === d.name)
      return {
        profile: d.name,
        region: configured?.regions?.[0] ?? d.region ?? ("" as AwsRegion),
        enabled: configured?.enabled ?? false
      }
    })

    yield* SubscriptionRef.update(state, (s) => ({ ...s, accounts: accountsState }))

    const enabledAccounts = config.accounts.filter((a) => a.enabled)

    if (enabledAccounts.length === 0) {
      const now = yield* Clock.currentTimeMillis
      yield* SubscriptionRef.update(
        state,
        (s) => ({ ...s, status: "idle" as const, lastUpdated: DateTime.toDate(DateTime.unsafeMake(now)) })
      )
      return
    }

    // --- Phase 2: Resolve AWS account IDs ---
    const accountIdMap = new Map<string, string>()

    const firstAccount = enabledAccounts[0]!
    const firstRegion = firstAccount.regions?.[0] ?? ("us-east-1" as AwsRegion)
    yield* awsClient.getCallerIdentity({ profile: firstAccount.profile, region: firstRegion }).pipe(
      Effect.tap((identity) => {
        accountIdMap.set(firstAccount.profile, identity.accountId)
        return SubscriptionRef.update(state, (s) => ({ ...s, currentUser: identity.username }))
      }),
      Effect.catchAll(() => Effect.void)
    )

    // Resolve remaining accounts
    yield* Effect.forEach(
      enabledAccounts.slice(1),
      (account) => {
        const region = account.regions?.[0] ?? ("us-east-1" as AwsRegion)
        return awsClient.getCallerIdentity({ profile: account.profile, region }).pipe(
          Effect.tap((identity) => Effect.sync(() => accountIdMap.set(account.profile, identity.accountId))),
          Effect.catchAll(() => Effect.void)
        )
      },
      { concurrency: 3 }
    )

    // Load subscriptions for diff
    const subscriptions = yield* subscriptionRepo.findAll().pipe(Effect.catchAll(() => Effect.succeed([])))
    const subscribedSet = new Set(subscriptions.map((s) => `${s.awsAccountId}:${s.pullRequestId}`))
    const currentUser = (yield* SubscriptionRef.get(state)).currentUser

    // --- Phase 3: Background AWS fetch ---
    const accountLabels = enabledAccounts.flatMap((a) => (a.regions ?? []).map((r) => `${a.profile}(${r})`))
    yield* SubscriptionRef.update(state, (s) => ({
      ...s,
      statusDetail: accountLabels.join(", ")
    }))

    const streams = enabledAccounts.flatMap((account) =>
      (account.regions ?? []).map((region) => {
        const label = `${account.profile} (${region})`
        const awsAccountId = accountIdMap.get(account.profile) ?? ""
        return awsClient.getPullRequests({ profile: account.profile, region }).pipe(
          Stream.map((pr) => ({ pr, label, awsAccountId })),
          Stream.catchAllCause((cause) => {
            const errorStr = Cause.pretty(cause).split("\n")[0] ?? "Unknown error"
            return Stream.fromEffect(
              notificationsService.add({
                type: "error" as const,
                title: label,
                message: errorStr,
                profile: account.profile
              })
            ).pipe(Stream.flatMap(() => Stream.empty))
          })
        )
      })
    )

    const seenKeys = new Set<string>()

    yield* Stream.mergeAll(streams, { concurrency: 2 }).pipe(
      Stream.runForEach(({ awsAccountId, label, pr }) =>
        Effect.gen(function*() {
          seenKeys.add(`${pr.account.profile}:${pr.id}`)
          // Diff subscribed PRs against cache
          if (awsAccountId && subscribedSet.has(`${awsAccountId}:${pr.id}`)) {
            const cached = yield* prRepo.findByAccountAndId(awsAccountId, pr.id).pipe(
              Effect.catchAll(() => Effect.succeed(Option.none()))
            )
            if (Option.isSome(cached)) {
              const notifications = diffPR(cached.value, prToUpsertInput(pr, awsAccountId), awsAccountId)
              yield* Effect.forEach(notifications, (n) => notificationRepo.add(n), { discard: true }).pipe(
                Effect.catchAll(() => Effect.void)
              )
            }
          }

          // Upsert to cache + auto-subscribe current user's PRs
          if (awsAccountId) {
            yield* prRepo.upsert(prToUpsertInput(pr, awsAccountId)).pipe(Effect.catchAll(() => Effect.void))
            if (currentUser && pr.author === currentUser) {
              yield* subscriptionRepo.subscribe(awsAccountId, pr.id).pipe(Effect.catchAll(() => Effect.void))
              subscribedSet.add(`${awsAccountId}:${pr.id}`)
            }
          }

          // Update state — inject awsAccountId, preserve commentCount, deduplicate
          yield* SubscriptionRef.update(state, (s) => {
            const existing = s.pullRequests.find((p) => p.id === pr.id && p.account.profile === pr.account.profile)
            const enrichedPR = new PullRequest({
              ...pr,
              account: awsAccountId ? new Account({ ...pr.account, awsAccountId }) : pr.account,
              commentCount: pr.commentCount ?? existing?.commentCount
            })
            const prs = s.pullRequests.filter((p) => !(p.id === pr.id && p.account.profile === pr.account.profile))
            const insertIdx = prs.findIndex((p) => p.creationDate.getTime() < pr.creationDate.getTime())
            const newPrs = insertIdx === -1
              ? [...prs, enrichedPR]
              : [...prs.slice(0, insertIdx), enrichedPR, ...prs.slice(insertIdx)]
            return {
              ...s,
              pullRequests: newPrs,
              statusDetail: `${label} #${pr.id} ${pr.repositoryName}`
            }
          })
        })
      )
    )

    // Remove stale PRs not seen in this refresh
    const now = yield* Clock.currentTimeMillis
    yield* SubscriptionRef.update(state, (s) => ({
      ...s,
      pullRequests: s.pullRequests.filter((p) => seenKeys.has(`${p.account.profile}:${p.id}`)),
      status: "idle" as const,
      statusDetail: undefined,
      lastUpdated: DateTime.toDate(DateTime.unsafeMake(now))
    }))

    // --- Phase 4: Comment enrichment ---
    const currentState = yield* SubscriptionRef.get(state)
    const enrichments = yield* Effect.forEach(
      currentState.pullRequests,
      (pr) => {
        const awsAccountId = accountIdMap.get(pr.account.profile) ?? ""
        return awsClient.getCommentsForPullRequest({
          account: { profile: pr.account.profile, region: pr.account.region },
          pullRequestId: pr.id,
          repositoryName: pr.repositoryName
        }).pipe(
          Effect.tap((locs) => {
            if (!awsAccountId) return Effect.void
            return Effect.gen(function*() {
              // Diff comments for subscribed PRs
              if (subscribedSet.has(`${awsAccountId}:${pr.id}`)) {
                const cachedComments = yield* commentRepo.find(awsAccountId, pr.id).pipe(
                  Effect.catchAll(() => Effect.succeed(Option.none()))
                )
                if (Option.isSome(cachedComments)) {
                  const notifications = diffComments(cachedComments.value, locs, pr.id, awsAccountId)
                  yield* Effect.forEach(notifications, (n) => notificationRepo.add(n), { discard: true }).pipe(
                    Effect.catchAll(() => Effect.void)
                  )
                }
              }
              // Cache comments
              yield* commentRepo.upsert(awsAccountId, pr.id, JSON.stringify(locs)).pipe(
                Effect.catchAll(() => Effect.void)
              )
            })
          }),
          Effect.map((locs) => ({ id: pr.id, accountId: pr.account.profile, commentCount: countAllComments(locs) })),
          Effect.catchAll((e) =>
            Effect.logWarning(`Comment enrichment failed for PR ${pr.id}: ${e}`).pipe(
              Effect.as(undefined)
            )
          )
        )
      },
      { concurrency: 3 }
    )

    const counts = new Map<string, number>()
    for (const r of enrichments) {
      if (r !== undefined) counts.set(`${r.accountId}:${r.id}`, r.commentCount)
    }
    if (counts.size > 0) {
      yield* SubscriptionRef.update(state, (s) => ({
        ...s,
        pullRequests: s.pullRequests.map((p) => {
          const key = `${p.account.profile}:${p.id}`
          const cc = counts.get(key)
          return cc !== undefined ? new PullRequest({ ...p, commentCount: cc }) : p
        })
      }))
    }

    // --- Phase 5: Update sync metadata ---
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
  }).pipe(
    Effect.withSpan("PRService.refresh"),
    Effect.timeout("120 seconds"),
    Effect.catchAllCause((cause) => {
      const errorStr = Cause.pretty(cause).split("\n")[0] ?? "Unknown error"
      return SubscriptionRef.update(state, (s) => ({ ...s, status: "error" as const, error: errorStr }))
    })
  )
