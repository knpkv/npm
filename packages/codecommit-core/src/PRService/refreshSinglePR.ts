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

import { Clock, Effect, Option, Schema, SubscriptionRef } from "effect"
import { AwsClient } from "../AwsClient/index.js"
import { diffApprovalPools, diffComments, diffPR } from "../CacheService/diff.js"
import { CommentRepo } from "../CacheService/repos/CommentRepo.js"
import { NotificationRepo } from "../CacheService/repos/NotificationRepo.js"
import type {
  CachedPullRequest,
  PullRequestRepoContract,
  UpsertInput
} from "../CacheService/repos/PullRequestRepo/index.js"
import { PullRequestAmbiguityError, PullRequestRepo } from "../CacheService/repos/PullRequestRepo/index.js"
import { SubscriptionRepo } from "../CacheService/repos/SubscriptionRepo.js"
import { ConfigService } from "../ConfigService/index.js"
import {
  AwsProfileName,
  AwsRegion,
  codecommitConsoleUrl,
  type PRCommentLocation,
  type PullRequestId,
  PullRequestStatus,
  type RepositoryName
} from "../Domain.js"
import { type AwsClientError, RefreshError } from "../Errors.js"
import { countAllComments, type PRState } from "./internal.js"

interface ResolvedAccount {
  readonly profile: AwsProfileName
  readonly region: AwsRegion
}

const decodeAwsProfileName = Schema.decodeUnknownSync(AwsProfileName)
const decodeAwsRegion = Schema.decodeUnknownSync(AwsRegion)
const decodePullRequestStatus = Schema.decodeUnknownSync(PullRequestStatus)

const resolvedAccount = (profile: string, region: string): ResolvedAccount => ({
  profile: decodeAwsProfileName(profile),
  region: decodeAwsRegion(region)
})

type RefreshSinglePREnv =
  | AwsClient
  | PullRequestRepo
  | CommentRepo
  | NotificationRepo
  | SubscriptionRepo
  | ConfigService

export interface RefreshSinglePRResult {
  readonly revisionId: string
  readonly sourceCommit: string
}
export type RefreshSinglePRError = AwsClientError | RefreshError

/** Exact repository and region used when a browser route disambiguates a PR. */
export interface RefreshSinglePRCoordinates {
  readonly repositoryName: RepositoryName
  readonly region: AwsRegion
}

/** Resolve profile/region from any cached PR with matching awsAccountId, or from config */
const resolveAccountFromCache = (
  prRepo: PullRequestRepoContract,
  awsAccountId: string,
  preferredRegion?: AwsRegion
) =>
  Effect.gen(function*() {
    // Check other cached PRs from the same AWS account
    const allCached = yield* prRepo.findAll().pipe(
      Effect.catch(() => Effect.succeed<Array<CachedPullRequest>>([]))
    )
    const sibling = allCached.find((p) =>
      p.awsAccountId === awsAccountId && (preferredRegion === undefined || p.accountRegion === preferredRegion)
    )
    if (sibling !== undefined) {
      return resolvedAccount(sibling.accountProfile, preferredRegion ?? sibling.accountRegion)
    }

    // Fall back to config — match by profile name (awsAccountId might be the profile name from URL)
    const configService = yield* ConfigService
    const config = yield* configService.load.pipe(Effect.catch(() => Effect.succeed({ accounts: [] })))
    const configAccount = config.accounts.find((a) => a.profile === awsAccountId && a.enabled)
    const region = preferredRegion ?? configAccount?.regions?.[0]
    if (configAccount !== undefined && region !== undefined) {
      return resolvedAccount(configAccount.profile, region)
    }

    return undefined
  })

export const makeRefreshSinglePR = (
  state: PRState
) => {
  const refreshSinglePR = Effect.fn("PRService.refreshSinglePR")(function*(
    awsAccountId: string,
    prId: PullRequestId,
    coordinates?: RefreshSinglePRCoordinates
  ) {
    const awsClient = yield* AwsClient
    const prRepo = yield* PullRequestRepo
    const commentRepo = yield* CommentRepo
    const notificationRepo = yield* NotificationRepo
    const subscriptionRepo = yield* SubscriptionRepo

    // Find PR in state to get account info
    const currentState = yield* SubscriptionRef.get(state)
    const stateMatches = currentState.pullRequests.filter(
      (p) =>
        p.id === prId &&
        p.account.awsAccountId === awsAccountId &&
        (coordinates === undefined ||
          (p.repositoryName === coordinates.repositoryName && p.account.region === coordinates.region))
    )
    if (coordinates === undefined && stateMatches.length > 1) {
      return yield* new RefreshError({
        failedAccounts: [awsAccountId],
        cause: new PullRequestAmbiguityError({
          awsAccountId,
          pullRequestId: prId,
          matches: stateMatches.length
        })
      })
    }
    const pr = stateMatches[0]

    // Also check cache
    const cachedPR: Option.Option<CachedPullRequest> = coordinates === undefined
      ? yield* prRepo.findByAccountAndId(awsAccountId, prId).pipe(
        Effect.catchTag(
          "PullRequestAmbiguityError",
          (cause) => Effect.fail(new RefreshError({ failedAccounts: [awsAccountId], cause }))
        ),
        Effect.catchTag("CacheError", () => Effect.succeed(Option.none<CachedPullRequest>()))
      )
      : yield* prRepo.findByCoordinates(awsAccountId, prId, coordinates.repositoryName, coordinates.region).pipe(
        Effect.catch(() => Effect.succeed(Option.none<CachedPullRequest>()))
      )

    // Resolve account: from state PR → cached PR → any cached PR with same awsAccountId → config
    const account: ResolvedAccount | undefined = pr !== undefined
      ? resolvedAccount(pr.account.profile, coordinates?.region ?? pr.account.region)
      : Option.isSome(cachedPR)
      ? resolvedAccount(cachedPR.value.accountProfile, coordinates?.region ?? cachedPR.value.accountRegion)
      : yield* resolveAccountFromCache(prRepo, awsAccountId, coordinates?.region)

    if (account === undefined) return yield* new RefreshError({ failedAccounts: [awsAccountId] })

    // Fetch fresh PR details
    const detail = yield* awsClient.getPullRequest({
      account,
      pullRequestId: prId
    })

    if (coordinates !== undefined && detail.repositoryName !== coordinates.repositoryName) {
      return yield* new RefreshError({ failedAccounts: [awsAccountId] })
    }

    // Fetch fresh comments
    const locs = yield* awsClient.getCommentsForPullRequest({
      account,
      pullRequestId: prId,
      repositoryName: detail.repositoryName
    }).pipe(Effect.catch(() => Effect.succeed<Array<PRCommentLocation>>([])))

    // Build fresh upsert — PullRequestDetail lacks some fields, fall back to cache
    const cached = Option.isSome(cachedPR) ? cachedPR.value : undefined
    const durableAccountId = cached?.awsAccountId ?? pr?.account.awsAccountId ?? awsAccountId
    const lastModifiedDate = cached !== undefined
      ? cached.lastModifiedDate.toISOString()
      : yield* Clock.currentTimeMillis.pipe(Effect.map((nowMs) => new Date(nowMs).toISOString()))
    const freshUpsert: UpsertInput = {
      id: prId,
      awsAccountId: durableAccountId,
      repoAccountId: detail.repoAccountId ?? cached?.repoAccountId ?? null,
      accountProfile: account.profile,
      accountRegion: account.region,
      title: detail.title,
      description: detail.description ?? null,
      author: detail.author,
      repositoryName: coordinates?.repositoryName ?? detail.repositoryName,
      creationDate: detail.creationDate.toISOString(),
      lastModifiedDate,
      status: decodePullRequestStatus(detail.status),
      sourceBranch: detail.sourceBranch,
      destinationBranch: detail.destinationBranch,
      isMergeable: cached !== undefined ? (cached.isMergeable ? 1 : 0) : detail.status === "MERGED" ? 1 : 0,
      isApproved: cached !== undefined ? (cached.isApproved ? 1 : 0) : detail.status === "MERGED" ? 1 : 0,
      commentCount: countAllComments(locs),
      link: cached?.link ?? pr?.link ??
        codecommitConsoleUrl(account.region, coordinates?.repositoryName ?? detail.repositoryName, prId),
      approvedBy: detail.approvedBy,
      approvedByArns: detail.approvedByArns,
      approvalRules: detail.approvalRules
    }

    // Diff for subscribed PRs
    const identity = {
      repositoryName: coordinates?.repositoryName ?? detail.repositoryName,
      accountRegion: account.region
    }
    const isSubscribed = yield* subscriptionRepo.isSubscribed(durableAccountId, prId, identity).pipe(
      Effect.catch(() => Effect.succeed(false))
    )

    if (isSubscribed && Option.isSome(cachedPR)) {
      const prNotifications = diffPR(cachedPR.value, freshUpsert, durableAccountId)
      const poolNotifications = diffApprovalPools(
        cachedPR.value.approvalRules ?? [],
        freshUpsert.approvalRules,
        currentState.currentUser,
        prId,
        durableAccountId,
        detail.title,
        account.profile
      )
      yield* Effect.forEach([...prNotifications, ...poolNotifications], (n) => notificationRepo.add(n), {
        discard: true
      }).pipe(
        Effect.catch(() => Effect.void)
      )

      // Diff comments
      const cachedComments = yield* commentRepo.find(durableAccountId, prId, identity).pipe(
        Effect.catch(() => Effect.succeed(Option.none<ReadonlyArray<PRCommentLocation>>()))
      )
      if (Option.isSome(cachedComments)) {
        const commentNotifications = diffComments(cachedComments.value, locs, prId, durableAccountId)
        yield* Effect.forEach(commentNotifications, (n) => notificationRepo.add(n), { discard: true }).pipe(
          Effect.catch(() => Effect.void)
        )
      }
    }

    // Cache comments
    yield* commentRepo.upsert(durableAccountId, prId, JSON.stringify(locs), identity).pipe(
      Effect.catch(() => Effect.void)
    )

    // Always upsert fresh data to cache
    yield* prRepo.upsert(freshUpsert).pipe(
      Effect.mapError((cause) => new RefreshError({ failedAccounts: [durableAccountId], cause }))
    )
    return {
      revisionId: detail.revisionId,
      sourceCommit: detail.sourceCommit
    }
  })

  return (
    awsAccountId: string,
    prId: PullRequestId,
    coordinates?: RefreshSinglePRCoordinates
  ): Effect.Effect<RefreshSinglePRResult, RefreshSinglePRError, RefreshSinglePREnv> =>
    refreshSinglePR(awsAccountId, prId, coordinates)
}
