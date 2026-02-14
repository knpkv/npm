/**
 * @internal
 */

import { Cause, Clock, DateTime, Effect, Option, Ref, Stream, SubscriptionRef } from "effect"
import { AwsClient } from "../AwsClient/index.js"
import { diffComments, diffPR } from "../CacheService/diff.js"
import { RepoChangeHub } from "../CacheService/RepoChangeHub.js"
import { CommentRepo } from "../CacheService/repos/CommentRepo.js"
import { NotificationRepo } from "../CacheService/repos/NotificationRepo.js"
import { PullRequestRepo } from "../CacheService/repos/PullRequestRepo.js"
import { SubscriptionRepo } from "../CacheService/repos/SubscriptionRepo.js"
import { SyncMetadataRepo } from "../CacheService/repos/SyncMetadataRepo.js"
import { ConfigService } from "../ConfigService/index.js"
import type { AwsProfileName, AwsRegion } from "../Domain.js"
import { NotificationsService } from "../NotificationsService.js"
import { countAllComments, decodeCachedPR, type PRState, prToUpsertInput } from "./internal.js"

export type RefreshDeps =
  | ConfigService
  | AwsClient
  | NotificationsService
  | PullRequestRepo
  | CommentRepo
  | NotificationRepo
  | SubscriptionRepo
  | SyncMetadataRepo
  | RepoChangeHub

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
    const hub = yield* RepoChangeHub

    // --- Phase 1: Load cached PRs immediately ---
    const cachedPRs = yield* prRepo.findAll().pipe(Effect.catchAll(() => Effect.succeed([])))

    yield* SubscriptionRef.update(state, (s) => ({
      ...s,
      pullRequests: cachedPRs.map(decodeCachedPR),
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
    const accountIdRef = yield* Ref.make(new Map<string, string>())

    const firstAccount = enabledAccounts[0]!
    const firstRegion = firstAccount.regions?.[0] ?? ("us-east-1" as AwsRegion)
    yield* awsClient.getCallerIdentity({ profile: firstAccount.profile, region: firstRegion }).pipe(
      Effect.tap((identity) =>
        Ref.update(accountIdRef, (m) => new Map(m).set(firstAccount.profile, identity.accountId)).pipe(
          Effect.zipRight(SubscriptionRef.update(state, (s) => ({ ...s, currentUser: identity.username })))
        )
      ),
      Effect.tapError((e) => Effect.logWarning(`getCallerIdentity failed for ${firstAccount.profile}`, e)),
      Effect.catchAll(() => Effect.void)
    )

    // Resolve remaining accounts
    yield* Effect.forEach(
      enabledAccounts.slice(1),
      (account) => {
        const region = account.regions?.[0] ?? ("us-east-1" as AwsRegion)
        return awsClient.getCallerIdentity({ profile: account.profile, region }).pipe(
          Effect.tap((identity) =>
            Ref.update(accountIdRef, (m) => new Map(m).set(account.profile, identity.accountId))
          ),
          Effect.tapError((e) => Effect.logWarning(`getCallerIdentity failed for ${account.profile}`, e)),
          Effect.catchAll(() => Effect.void)
        )
      },
      { concurrency: 3 }
    )

    // Snapshot after Phase 2 — read-only from here
    const accountIdMap = yield* Ref.get(accountIdRef)

    // Load subscriptions for diff
    const subscriptions = yield* subscriptionRepo.findAll().pipe(Effect.catchAll(() => Effect.succeed([])))
    const subscribedRef = yield* Ref.make(new Set(subscriptions.map((s) => `${s.awsAccountId}:${s.pullRequestId}`)))
    const currentUser = (yield* SubscriptionRef.get(state)).currentUser

    // Capture timestamp before Phase 3 upserts for stale deletion
    const phase3Start = new Date().toISOString()

    // --- Phase 3 + Phase 4: Batched writes (suppresses per-upsert change events) ---
    yield* hub.batch(
      Effect.gen(function*() {
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

        yield* Stream.mergeAll(streams, { concurrency: 2 }).pipe(
          Stream.runForEach(({ awsAccountId, label, pr }) =>
            Effect.gen(function*() {
              // Diff subscribed PRs against cache
              const subscribed = yield* Ref.get(subscribedRef)
              if (awsAccountId && subscribed.has(`${awsAccountId}:${pr.id}`)) {
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
                yield* prRepo.upsert(prToUpsertInput(pr, awsAccountId)).pipe(
                  Effect.tapError((e) => Effect.logWarning("cache upsert error", e)),
                  Effect.catchAll(() => Effect.void)
                )
                if (currentUser && pr.author === currentUser) {
                  yield* subscriptionRepo.subscribe(awsAccountId, pr.id).pipe(Effect.catchAll(() => Effect.void))
                  yield* Ref.update(subscribedRef, (s) => new Set(s).add(`${awsAccountId}:${pr.id}`))
                }
              }

              // Update statusDetail only (PRs come from SQLite via RepoChangeHub)
              yield* SubscriptionRef.update(state, (s) => ({
                ...s,
                statusDetail: `${label} #${pr.id} ${pr.repositoryName}`
              }))
            })
          )
        )

        // Remove stale PRs not refreshed in this cycle
        yield* prRepo.deleteStale(phase3Start).pipe(Effect.catchAll(() => Effect.void))

        // --- Phase 4: Comment enrichment ---
        const freshPRs = yield* prRepo.findAll().pipe(Effect.catchAll(() => Effect.succeed([])))
        const subscribedSnapshot = yield* Ref.get(subscribedRef)

        yield* Effect.forEach(
          freshPRs,
          (row) => {
            const awsAccountId = row.awsAccountId
            const prId = row.id
            return awsClient.getCommentsForPullRequest({
              account: {
                profile: row.accountProfile as AwsProfileName,
                region: row.accountRegion as AwsRegion
              },
              pullRequestId: prId,
              repositoryName: row.repositoryName
            }).pipe(
              Effect.tap((locs) => {
                if (!awsAccountId) return Effect.void
                return Effect.gen(function*() {
                  // Diff comments for subscribed PRs
                  if (subscribedSnapshot.has(`${awsAccountId}:${prId}`)) {
                    const cachedComments = yield* commentRepo.find(awsAccountId, prId).pipe(
                      Effect.catchAll(() => Effect.succeed(Option.none()))
                    )
                    if (Option.isSome(cachedComments)) {
                      const notifications = diffComments(cachedComments.value, locs, prId, awsAccountId)
                      yield* Effect.forEach(notifications, (n) => notificationRepo.add(n), { discard: true }).pipe(
                        Effect.catchAll(() => Effect.void)
                      )
                    }
                  }
                  // Cache comments
                  yield* commentRepo.upsert(awsAccountId, prId, JSON.stringify(locs)).pipe(
                    Effect.catchAll(() => Effect.void)
                  )
                })
              }),
              Effect.map((locs) => ({ awsAccountId, id: prId, commentCount: countAllComments(locs) })),
              Effect.catchAll(() => {
                // Fallback: use cached comment count from DB
                if (!awsAccountId) return Effect.succeed(undefined)
                return commentRepo.find(awsAccountId, prId).pipe(
                  Effect.map(Option.match({
                    onNone: () => ({ awsAccountId, id: prId, commentCount: 0 }),
                    onSome: (cached) => ({
                      awsAccountId,
                      id: prId,
                      commentCount: countAllComments(cached)
                    })
                  })),
                  Effect.catchAll(() => Effect.succeed(undefined))
                )
              })
            )
          },
          { concurrency: 2 }
        ).pipe(
          Effect.tap((enrichments) =>
            Effect.forEach(
              enrichments,
              (r) =>
                r !== undefined
                  ? prRepo.updateCommentCount(r.awsAccountId, r.id, r.commentCount).pipe(
                    Effect.catchAll(() => Effect.void)
                  )
                  : Effect.void,
              { discard: true }
            )
          )
        )
      })
    )
    // Batch ends here — accumulated change events flush atomically

    // Update status to idle
    const now = yield* Clock.currentTimeMillis
    yield* SubscriptionRef.update(state, (s) => ({
      ...s,
      status: "idle" as const,
      statusDetail: undefined,
      lastUpdated: DateTime.toDate(DateTime.unsafeMake(now))
    }))

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
