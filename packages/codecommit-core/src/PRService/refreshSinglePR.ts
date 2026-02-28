/**
 * @internal
 */

import { Cause, Effect, Option, SubscriptionRef } from "effect"
import { AwsClient } from "../AwsClient/index.js"
import { diffComments, diffPR } from "../CacheService/diff.js"
import { CommentRepo } from "../CacheService/repos/CommentRepo.js"
import { NotificationRepo } from "../CacheService/repos/NotificationRepo.js"
import type { UpsertInput } from "../CacheService/repos/PullRequestRepo.js"
import { PullRequestRepo } from "../CacheService/repos/PullRequestRepo.js"
import { SubscriptionRepo } from "../CacheService/repos/SubscriptionRepo.js"
import { ConfigService } from "../ConfigService/index.js"
import type { PullRequestId } from "../Domain.js"
import { countAllComments, type PRState } from "./internal.js"

/** Resolve profile/region from any cached PR with matching awsAccountId, or from config */
const resolveAccountFromCache = (prRepo: PullRequestRepo, awsAccountId: string) =>
  Effect.gen(function*() {
    // Check other cached PRs from the same AWS account
    const allCached = yield* prRepo.findAll().pipe(Effect.catchAll(() => Effect.succeed([])))
    const sibling = allCached.find((p) => p.awsAccountId === awsAccountId)
    if (sibling) return { profile: sibling.accountProfile, region: sibling.accountRegion }

    // Fall back to config — match by profile name (awsAccountId might be the profile name from URL)
    const configService = yield* ConfigService
    const config = yield* configService.load.pipe(Effect.catchAll(() => Effect.succeed({ accounts: [] })))
    const configAccount = config.accounts.find((a) => a.profile === awsAccountId && a.enabled)
    if (configAccount && configAccount.regions?.[0]) {
      return { profile: configAccount.profile, region: configAccount.regions[0] }
    }

    return undefined
  })

export const makeRefreshSinglePR = (
  state: PRState
) =>
  Effect.fn("PRService.refreshSinglePR")(function*(awsAccountId: string, prId: PullRequestId) {
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

    // Resolve account: from state PR → cached PR → any cached PR with same awsAccountId → config
    const account = pr
      ? { profile: pr.account.profile, region: pr.account.region }
      : Option.isSome(cachedPR)
      ? { profile: cachedPR.value.accountProfile, region: cachedPR.value.accountRegion }
      : yield* resolveAccountFromCache(prRepo, awsAccountId)

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
      lastModifiedDate: cached?.lastModifiedDate.toISOString() ?? new Date().toISOString(),
      status: detail.status,
      sourceBranch: detail.sourceBranch,
      destinationBranch: detail.destinationBranch,
      isMergeable: cached ? (cached.isMergeable ? 1 : 0) : detail.status === "MERGED" ? 1 : 0,
      isApproved: cached ? (cached.isApproved ? 1 : 0) : detail.status === "MERGED" ? 1 : 0,
      commentCount: countAllComments(locs),
      link: cached?.link ?? pr?.link
        ?? `https://${account.region}.console.aws.amazon.com/codesuite/codecommit/repositories/${detail.repositoryName}/pull-requests/${prId}?region=${account.region}`
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
  }, (effect) =>
    effect.pipe(
      Effect.catchAllCause((cause) =>
        Cause.isInterruptedOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("refreshSinglePR failed", cause)
      )
    ))
