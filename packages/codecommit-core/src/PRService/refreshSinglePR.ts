/**
 * Refreshes a single PR by ID (e.g. from webhook or manual refresh).
 *
 * Fetches fresh detail and comments from AWS, diffs against cache (field
 * changes, approval pool membership, comment changes), emits notifications,
 * and upserts the result. Uses `detail.repoAccountId` from getPullRequest
 * with fallback to cached value.
 *
 * @internal
 */

import { Cause, Effect, Option, SubscriptionRef } from "effect"
import { AwsClient } from "../AwsClient/index.js"
import { diffApprovalPools, diffComments, diffPR } from "../CacheService/diff.js"
import { CommentRepo } from "../CacheService/repos/CommentRepo.js"
import { NotificationRepo } from "../CacheService/repos/NotificationRepo.js"
import type {
  CachedPullRequest,
  PullRequestRepoShape,
  UpsertInput
} from "../CacheService/repos/PullRequestRepo/index.js"
import { PullRequestRepo } from "../CacheService/repos/PullRequestRepo/index.js"
import { SubscriptionRepo } from "../CacheService/repos/SubscriptionRepo.js"
import { ConfigService } from "../ConfigService/index.js"
import {
  type AwsProfileName,
  type AwsRegion,
  codecommitConsoleUrl,
  type PRCommentLocation,
  type PullRequestId,
  type PullRequestStatus
} from "../Domain.js"
import { countAllComments, type PRState } from "./internal.js"

interface ResolvedAccount {
  readonly profile: AwsProfileName
  readonly region: AwsRegion
}

type RefreshSinglePREnv =
  | AwsClient
  | PullRequestRepo
  | CommentRepo
  | NotificationRepo
  | SubscriptionRepo
  | ConfigService

/** Resolve profile/region from any cached PR with matching awsAccountId, or from config */
const resolveAccountFromCache = (prRepo: PullRequestRepoShape, awsAccountId: string) =>
  Effect.gen(function*() {
    // Check other cached PRs from the same AWS account
    const allCached = yield* prRepo.findAll().pipe(
      Effect.catchCause(() => Effect.succeed<Array<CachedPullRequest>>([]))
    )
    const sibling = allCached.find((p) => p.awsAccountId === awsAccountId)
    if (sibling) {
      return {
        profile: sibling.accountProfile as AwsProfileName,
        region: sibling.accountRegion as AwsRegion
      } satisfies ResolvedAccount
    }

    // Fall back to config — match by profile name (awsAccountId might be the profile name from URL)
    const configService = yield* ConfigService
    const config = yield* configService.load.pipe(Effect.catchCause(() => Effect.succeed({ accounts: [] })))
    const configAccount = config.accounts.find((a) => a.profile === awsAccountId && a.enabled)
    if (configAccount && configAccount.regions?.[0]) {
      return { profile: configAccount.profile, region: configAccount.regions[0] } satisfies ResolvedAccount
    }

    return undefined
  })

export const makeRefreshSinglePR = (
  state: PRState
) => {
  const refreshSinglePR = Effect.fn("PRService.refreshSinglePR")(function*(awsAccountId: string, prId: PullRequestId) {
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
      Effect.map((row) => Option.some(row)),
      Effect.catchCause(() => Effect.succeed(Option.none<CachedPullRequest>()))
    )

    // Resolve account: from state PR → cached PR → any cached PR with same awsAccountId → config
    const account: ResolvedAccount | undefined = pr
      ? { profile: pr.account.profile as AwsProfileName, region: pr.account.region as AwsRegion }
      : Option.isSome(cachedPR)
      ? {
        profile: cachedPR.value.accountProfile as AwsProfileName,
        region: cachedPR.value.accountRegion as AwsRegion
      }
      : yield* resolveAccountFromCache(prRepo, awsAccountId)

    if (!account) return

    // Fetch fresh PR details
    const detail = yield* awsClient.getPullRequest({
      account,
      pullRequestId: prId
    }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))

    if (!detail) return

    // Fetch fresh comments
    const locs = yield* awsClient.getCommentsForPullRequest({
      account,
      pullRequestId: prId,
      repositoryName: detail.repositoryName
    }).pipe(Effect.catchCause(() => Effect.succeed<Array<PRCommentLocation>>([])))

    // Build fresh upsert — PullRequestDetail lacks some fields, fall back to cache
    const cached = Option.isSome(cachedPR) ? cachedPR.value : undefined
    const freshUpsert: UpsertInput = {
      id: prId,
      awsAccountId,
      repoAccountId: detail.repoAccountId ?? cached?.repoAccountId ?? null,
      accountProfile: account.profile,
      accountRegion: account.region,
      title: detail.title,
      description: detail.description ?? null,
      author: detail.author,
      repositoryName: detail.repositoryName,
      creationDate: detail.creationDate.toISOString(),
      lastModifiedDate: cached?.lastModifiedDate.toISOString() ?? new Date().toISOString(),
      status: detail.status as PullRequestStatus,
      sourceBranch: detail.sourceBranch,
      destinationBranch: detail.destinationBranch,
      isMergeable: cached ? (cached.isMergeable ? 1 : 0) : detail.status === "MERGED" ? 1 : 0,
      isApproved: cached ? (cached.isApproved ? 1 : 0) : detail.status === "MERGED" ? 1 : 0,
      commentCount: countAllComments(locs),
      link: cached?.link ?? pr?.link ?? codecommitConsoleUrl(account.region, detail.repositoryName, prId),
      approvedBy: detail.approvedBy,
      approvedByArns: detail.approvedByArns,
      approvalRules: detail.approvalRules
    }

    // Diff for subscribed PRs
    const isSubscribed = yield* subscriptionRepo.isSubscribed(awsAccountId, prId).pipe(
      Effect.catchCause(() => Effect.succeed(false))
    )

    if (isSubscribed && Option.isSome(cachedPR)) {
      const prNotifications = diffPR(cachedPR.value, freshUpsert, awsAccountId)
      const poolNotifications = diffApprovalPools(
        cachedPR.value.approvalRules ?? [],
        freshUpsert.approvalRules,
        currentState.currentUser,
        prId,
        awsAccountId,
        detail.title,
        account.profile
      )
      yield* Effect.forEach([...prNotifications, ...poolNotifications], (n) => notificationRepo.add(n), {
        discard: true
      }).pipe(
        Effect.catchCause(() => Effect.void)
      )

      // Diff comments
      const cachedComments = yield* commentRepo.find(awsAccountId, prId).pipe(
        Effect.catchCause(() => Effect.succeed(Option.none<ReadonlyArray<PRCommentLocation>>()))
      )
      if (Option.isSome(cachedComments)) {
        const commentNotifications = diffComments(cachedComments.value, locs, prId, awsAccountId)
        yield* Effect.forEach(commentNotifications, (n) => notificationRepo.add(n), { discard: true }).pipe(
          Effect.catchCause(() => Effect.void)
        )
      }
    }

    // Cache comments
    yield* commentRepo.upsert(awsAccountId, prId, JSON.stringify(locs)).pipe(
      Effect.catchCause(() => Effect.void)
    )

    // Always upsert fresh data to cache
    yield* prRepo.upsert(freshUpsert).pipe(Effect.catchCause(() => Effect.void))
  }, (effect) =>
    effect.pipe(
      Effect.catchCause((cause): Effect.Effect<void> =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("refreshSinglePR failed", cause)
      )
    ))

  return (awsAccountId: string, prId: PullRequestId) =>
    refreshSinglePR(awsAccountId, prId) as Effect.Effect<void, never, RefreshSinglePREnv>
}
