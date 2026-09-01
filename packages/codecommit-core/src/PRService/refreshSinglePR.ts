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

import { Effect, Option, Schema, SubscriptionRef } from "effect"
import { AwsClient } from "../AwsClient/index.js"
import { diffApprovalPools, diffComments, diffPR } from "../CacheService/diff.js"
import { CommentRepo } from "../CacheService/repos/CommentRepo.js"
import { NotificationRepo } from "../CacheService/repos/NotificationRepo.js"
import type {
  CachedPullRequest,
  PullRequestRepoContract,
  UpsertInput
} from "../CacheService/repos/PullRequestRepo/index.js"
import { PullRequestRepo } from "../CacheService/repos/PullRequestRepo/index.js"
import { SubscriptionRepo } from "../CacheService/repos/SubscriptionRepo.js"
import { ConfigService } from "../ConfigService/index.js"
import {
  AwsProfileName,
  AwsRegion,
  codecommitConsoleUrl,
  type PRCommentLocation,
  type PullRequestId,
  PullRequestStatus
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
export interface RefreshSinglePRCoordinates {
  readonly repositoryName: string
  readonly region: AwsRegion
}
export type RefreshSinglePRRequest = RefreshSinglePRCoordinates | undefined
export type RefreshSinglePRError = AwsClientError | RefreshError

const matchesAccount = (
  account: {
    readonly awsAccountId?: string | undefined
    readonly repoAccountId?: string | null | undefined
    readonly profile?: string | undefined
  },
  awsAccountId: string
): boolean =>
  account.awsAccountId === awsAccountId || account.repoAccountId === awsAccountId || account.profile === awsAccountId

/** Resolve profile/region from the exact cached provider coordinates, or from config. */
const resolveAccountFromCache = (
  prRepo: PullRequestRepoContract,
  awsAccountId: string,
  prId: PullRequestId,
  coordinates: RefreshSinglePRRequest
) =>
  Effect.gen(function*() {
    const allCached = yield* prRepo.findAll().pipe(
      Effect.catch(() => Effect.succeed<Array<CachedPullRequest>>([]))
    )
    const candidates = allCached.filter(
      (p) =>
        p.id === prId &&
        matchesAccount({
          awsAccountId: p.awsAccountId,
          repoAccountId: p.repoAccountId,
          profile: p.accountProfile
        }, awsAccountId) &&
        (coordinates === undefined ||
          (p.repositoryName === coordinates.repositoryName && p.accountRegion === coordinates.region))
    )
    if (coordinates === undefined && candidates.length > 1) return undefined
    const sibling = coordinates === undefined && candidates.length !== 1 ? undefined : candidates[0]
    if (sibling !== undefined) {
      return resolvedAccount(sibling.accountProfile, sibling.accountRegion)
    }

    const configService = yield* ConfigService
    const config = yield* configService.load.pipe(Effect.catch(() => Effect.succeed({ accounts: [] })))
    const configAccount = config.accounts.find((a) => a.profile === awsAccountId && a.enabled)
    if (configAccount !== undefined) {
      const region = coordinates !== undefined
        ? configAccount.regions.includes(coordinates.region) ? coordinates.region : undefined
        : configAccount.regions.length === 1
        ? configAccount.regions[0]
        : undefined
      if (region !== undefined) return resolvedAccount(configAccount.profile, region)
    }

    return undefined
  })

export const makeRefreshSinglePR = (
  state: PRState
) => {
  const refreshSinglePR = Effect.fn("PRService.refreshSinglePR")(function*(
    awsAccountId: string,
    prId: PullRequestId,
    coordinates: RefreshSinglePRRequest
  ) {
    const awsClient = yield* AwsClient
    const prRepo = yield* PullRequestRepo
    const commentRepo = yield* CommentRepo
    const notificationRepo = yield* NotificationRepo
    const subscriptionRepo = yield* SubscriptionRepo

    const currentState = yield* SubscriptionRef.get(state)
    const stateCandidates = currentState.pullRequests.filter(
      (p) =>
        p.id === prId &&
        matchesAccount(p.account, awsAccountId) &&
        (coordinates === undefined ||
          (p.repositoryName === coordinates.repositoryName && p.account.region === coordinates.region))
    )
    const legacyStateAmbiguous = coordinates === undefined && stateCandidates.length > 1
    const pr = coordinates === undefined && stateCandidates.length !== 1 ? undefined : stateCandidates[0]

    const cachedPR = yield* prRepo.findAll().pipe(
      Effect.map((rows) => {
        if (legacyStateAmbiguous) return Option.none<CachedPullRequest>()
        const candidates = rows.filter(
          (row) =>
            row.id === prId &&
            matchesAccount({
              awsAccountId: row.awsAccountId,
              repoAccountId: row.repoAccountId,
              profile: row.accountProfile
            }, awsAccountId) &&
            (coordinates === undefined ||
              (row.repositoryName === coordinates.repositoryName && row.accountRegion === coordinates.region))
        )
        const match = coordinates === undefined && candidates.length !== 1 ? undefined : candidates[0]
        return match === undefined ? Option.none<CachedPullRequest>() : Option.some(match)
      }),
      Effect.catch(() => Effect.succeed(Option.none<CachedPullRequest>()))
    )

    const account: ResolvedAccount | undefined = pr !== undefined
      ? resolvedAccount(pr.account.profile, pr.account.region)
      : Option.isSome(cachedPR) === true
      ? resolvedAccount(cachedPR.value.accountProfile, cachedPR.value.accountRegion)
      : yield* resolveAccountFromCache(prRepo, awsAccountId, prId, coordinates)

    if (account === undefined) return yield* new RefreshError({ failedAccounts: [awsAccountId] })

    // Fetch fresh PR details
    const detail = yield* awsClient.getPullRequest({
      account,
      pullRequestId: prId
    })

    // Fetch fresh comments
    const locs = yield* awsClient.getCommentsForPullRequest({
      account,
      pullRequestId: prId,
      repositoryName: detail.repositoryName
    }).pipe(Effect.catch(() => Effect.succeed<Array<PRCommentLocation>>([])))

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
      status: decodePullRequestStatus(detail.status),
      sourceBranch: detail.sourceBranch,
      destinationBranch: detail.destinationBranch,
      isMergeable: cached !== undefined ? (cached.isMergeable ? 1 : 0) : detail.status === "MERGED" ? 1 : 0,
      isApproved: cached !== undefined ? (cached.isApproved ? 1 : 0) : detail.status === "MERGED" ? 1 : 0,
      commentCount: countAllComments(locs),
      link: cached?.link ?? pr?.link ?? codecommitConsoleUrl(account.region, detail.repositoryName, prId),
      approvedBy: detail.approvedBy,
      approvedByArns: detail.approvedByArns,
      approvalRules: detail.approvalRules
    }

    // Diff for subscribed PRs
    const isSubscribed = yield* subscriptionRepo.isSubscribed(awsAccountId, prId).pipe(
      Effect.catch(() => Effect.succeed(false))
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
        Effect.catch(() => Effect.void)
      )

      // Diff comments
      const cachedComments = yield* commentRepo.find(awsAccountId, prId).pipe(
        Effect.catch(() => Effect.succeed(Option.none<ReadonlyArray<PRCommentLocation>>()))
      )
      if (Option.isSome(cachedComments)) {
        const commentNotifications = diffComments(cachedComments.value, locs, prId, awsAccountId)
        yield* Effect.forEach(commentNotifications, (n) => notificationRepo.add(n), { discard: true }).pipe(
          Effect.catch(() => Effect.void)
        )
      }
    }

    // Cache comments
    yield* commentRepo.upsert(awsAccountId, prId, JSON.stringify(locs)).pipe(
      Effect.catch(() => Effect.void)
    )

    // Always upsert fresh data to cache
    yield* prRepo.upsert(freshUpsert).pipe(
      Effect.mapError((cause) => new RefreshError({ failedAccounts: [awsAccountId], cause }))
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
