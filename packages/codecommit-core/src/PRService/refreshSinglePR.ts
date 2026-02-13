/**
 * @internal
 */

import { Effect, Option, SubscriptionRef } from "effect"
import { AwsClient } from "../AwsClient/index.js"
import { diffComments, diffPR } from "../CacheService/diff.js"
import { CommentRepo } from "../CacheService/repos/CommentRepo.js"
import { NotificationRepo } from "../CacheService/repos/NotificationRepo.js"
import type { UpsertInput } from "../CacheService/repos/PullRequestRepo.js"
import { PullRequestRepo } from "../CacheService/repos/PullRequestRepo.js"
import { SubscriptionRepo } from "../CacheService/repos/SubscriptionRepo.js"
import type { AwsProfileName, AwsRegion, PullRequestId } from "../Domain.js"
import { countAllComments, type PRState } from "./internal.js"
import type { RefreshDeps } from "./refresh.js"

export const makeRefreshSinglePR = (
  state: PRState
) =>
(awsAccountId: string, prId: PullRequestId): Effect.Effect<void, never, RefreshDeps> =>
  Effect.gen(function*() {
    const awsClient = yield* AwsClient
    const prRepo = yield* PullRequestRepo
    const commentRepo = yield* CommentRepo
    const notificationRepo = yield* NotificationRepo
    const subscriptionRepo = yield* SubscriptionRepo

    // Find PR in state to get account info
    const currentState = yield* SubscriptionRef.get(state)
    const pr = currentState.pullRequests.find((p) => p.id === prId && p.account.awsAccountId === awsAccountId)

    // Also check cache
    const cachedPR = yield* prRepo.findByAccountAndId(awsAccountId, prId).pipe(
      Effect.catchAll(() => Effect.succeed(Option.none()))
    )

    const account = pr
      ? { profile: pr.account.profile, region: pr.account.region }
      : Option.isSome(cachedPR)
      ? { profile: cachedPR.value.accountProfile as AwsProfileName, region: cachedPR.value.accountRegion as AwsRegion }
      : undefined

    if (!account) return

    // Fetch fresh PR details
    const detail = yield* awsClient.getPullRequest({
      account,
      pullRequestId: prId
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))

    if (!detail) return

    // Fetch fresh comments
    const locs = yield* awsClient.getCommentsForPullRequest({
      account,
      pullRequestId: prId,
      repositoryName: detail.repositoryName
    }).pipe(Effect.catchAll(() => Effect.succeed([])))

    // Build fresh upsert — PullRequestDetail lacks some fields, fall back to cache
    const cached = Option.isSome(cachedPR) ? cachedPR.value : undefined
    const freshUpsert: UpsertInput = {
      id: prId,
      awsAccountId,
      accountProfile: account.profile,
      accountRegion: account.region,
      title: detail.title,
      description: detail.description ?? null,
      author: detail.author,
      repositoryName: detail.repositoryName,
      creationDate: detail.creationDate.toISOString(),
      lastModifiedDate: cached?.lastModifiedDate ?? new Date().toISOString(),
      status: detail.status,
      sourceBranch: detail.sourceBranch,
      destinationBranch: detail.destinationBranch,
      isMergeable: cached?.isMergeable ?? 0,
      isApproved: cached?.isApproved ?? 0,
      commentCount: countAllComments(locs),
      link: cached?.link ?? pr?.link ?? ""
    }

    // Diff for subscribed PRs
    const isSubscribed = yield* subscriptionRepo.isSubscribed(awsAccountId, prId).pipe(
      Effect.catchAll(() => Effect.succeed(false))
    )

    if (isSubscribed && Option.isSome(cachedPR)) {
      const prNotifications = diffPR(cachedPR.value, freshUpsert, awsAccountId)
      yield* Effect.forEach(prNotifications, (n) => notificationRepo.add(n), { discard: true }).pipe(
        Effect.catchAll(() => Effect.void)
      )

      // Diff comments
      const cachedComments = yield* commentRepo.find(awsAccountId, prId).pipe(
        Effect.catchAll(() => Effect.succeed(Option.none()))
      )
      if (Option.isSome(cachedComments)) {
        const commentNotifications = diffComments(cachedComments.value, locs, prId, awsAccountId)
        yield* Effect.forEach(commentNotifications, (n) => notificationRepo.add(n), { discard: true }).pipe(
          Effect.catchAll(() => Effect.void)
        )
      }
    }

    // Cache comments
    yield* commentRepo.upsert(awsAccountId, prId, JSON.stringify(locs)).pipe(
      Effect.catchAll(() => Effect.void)
    )

    // Always upsert fresh data to cache
    yield* prRepo.upsert(freshUpsert).pipe(Effect.catchAll(() => Effect.void))
  }).pipe(
    Effect.withSpan("PRService.refreshSinglePR"),
    Effect.catchAllCause(() => Effect.void)
  )
