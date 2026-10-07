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
import { diffApprovalPools, diffComments, diffPR, notificationsFor } from "../CacheService/diff.js"
import { CommentRepo } from "../CacheService/repos/CommentRepo.js"
import { type NewNotification, NotificationRepo } from "../CacheService/repos/NotificationRepo.js"
import type {
  CachedPullRequest,
  PullRequestRepoContract,
  UpsertInput
} from "../CacheService/repos/PullRequestRepo/index.js"
import {
  approvalColumnsOf,
  PullRequestAmbiguityError,
  PullRequestRepo
} from "../CacheService/repos/PullRequestRepo/index.js"
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
  readonly durableAccountId?: string
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
  /** Coordinate tokens carry a durable account identity, not a profile alias. */
  readonly accountIdSource?: "coordinate-token"
}

const matchesAccount = (
  account: Readonly<{
    readonly awsAccountId?: string | null | undefined
    readonly repoAccountId?: string | null | undefined
    readonly profile?: string | null | undefined
  }>,
  awsAccountId: string
): boolean => {
  if (account.awsAccountId !== undefined && account.awsAccountId !== null && account.awsAccountId !== "") {
    return account.awsAccountId === awsAccountId || account.profile === awsAccountId
  }
  return account.repoAccountId === awsAccountId || account.profile === awsAccountId
}

const matchesRequestedAccount = (
  account: Readonly<{
    readonly awsAccountId?: string | null | undefined
    readonly repoAccountId?: string | null | undefined
    readonly profile?: string | null | undefined
  }>,
  awsAccountId: string,
  coordinates: RefreshSinglePRCoordinates | undefined
): boolean => {
  if (coordinates === undefined) return matchesAccount(account, awsAccountId)
  if (coordinates.accountIdSource === "coordinate-token") {
    return account.awsAccountId === awsAccountId
  }
  if (account.awsAccountId !== undefined && account.awsAccountId !== null && account.awsAccountId !== "") {
    return account.awsAccountId === awsAccountId || account.profile === awsAccountId
  }
  return account.profile === awsAccountId || account.repoAccountId === awsAccountId
}

/** Resolve profile/region from an exact cached PR, or from config. */
const resolveAccountFromCache = (
  prRepo: PullRequestRepoContract,
  awsAccountId: string,
  prId: PullRequestId,
  coordinates?: RefreshSinglePRCoordinates
) =>
  Effect.gen(function*() {
    // A coordinate-free lookup is only safe when exactly one cached PR matches.
    const allCached = yield* prRepo.findAll().pipe(
      Effect.catch(() => Effect.succeed<Array<CachedPullRequest>>([]))
    )
    const candidates = allCached.filter((p) =>
      p.id === prId &&
      matchesRequestedAccount(
        {
          awsAccountId: p.awsAccountId,
          repoAccountId: p.repoAccountId,
          profile: p.accountProfile
        },
        awsAccountId,
        coordinates
      ) &&
      (coordinates === undefined ||
        (p.repositoryName === coordinates.repositoryName && p.accountRegion === coordinates.region))
    )
    if (coordinates === undefined && candidates.length !== 1) return undefined
    const sibling = candidates[0]
    if (sibling !== undefined) {
      return {
        ...resolvedAccount(sibling.accountProfile, coordinates?.region ?? sibling.accountRegion),
        durableAccountId: sibling.awsAccountId
      }
    }

    // Fall back to config only when the requested region is configured.
    const configService = yield* ConfigService
    const config = yield* configService.load.pipe(Effect.catch(() => Effect.succeed({ accounts: [] })))
    const configAccount = config.accounts.find((a) => a.profile === awsAccountId && a.enabled)
    const region = coordinates !== undefined
      ? configAccount?.regions.includes(coordinates.region) === true ? coordinates.region : undefined
      : configAccount?.regions.length === 1
      ? configAccount.regions[0]
      : undefined
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
        matchesRequestedAccount(p.account, awsAccountId, coordinates) &&
        (coordinates === undefined ||
          (p.repositoryName === coordinates.repositoryName && p.account.region === coordinates.region))
    )
    if (stateMatches.length > 1) {
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
      : yield* resolveAccountFromCache(prRepo, awsAccountId, prId, coordinates)

    if (account === undefined) return yield* new RefreshError({ failedAccounts: [awsAccountId] })

    // Fetch fresh PR details, after taking the observation number: a read that began later wins.
    const observation = yield* prRepo.observe().pipe(
      Effect.mapError((cause) => new RefreshError({ failedAccounts: [awsAccountId], cause }))
    )
    const detail = yield* awsClient.getPullRequest({
      account,
      pullRequestId: prId
    })

    if (coordinates !== undefined && detail.repositoryName !== coordinates.repositoryName) {
      return yield* new RefreshError({ failedAccounts: [awsAccountId] })
    }

    // Fresh comments, or none when the fetch failed. A failure is not "no comments": the count stays
    // not loaded and the comment cache untouched, so the next successful fetch re-announces nothing.
    const fetched = yield* awsClient.getCommentsForPullRequest({
      account,
      pullRequestId: prId,
      repositoryName: detail.repositoryName
    }).pipe(
      Effect.map(Option.some),
      Effect.tapError((e) => Effect.logWarning("comment fetch failed; keeping the cached comments", e)),
      Effect.catch(() => Effect.succeed(Option.none<ReadonlyArray<PRCommentLocation>>()))
    )

    // Build fresh upsert — PullRequestDetail lacks some fields, fall back to cache
    const cached = Option.isSome(cachedPR) ? cachedPR.value : undefined
    const durableAccountId = cached?.awsAccountId ?? pr?.account.awsAccountId ?? account.durableAccountId ??
      (account.profile === awsAccountId
        ? (yield* awsClient.getCallerIdentity(account)).accountId
        : awsAccountId)
    // The read's own version: the cache's compare-and-set then stores it only if the row isn't newer.
    const lastModifiedDate = detail.lastActivityDate.toISOString()
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
      // From this read, so its row group is whole: a cached value would carry an older revision's.
      isMergeable: detail.isMergeable ? 1 : 0,
      // A failed evaluation keeps the last known approval: the upsert keeps the cached value.
      ...approvalColumnsOf(detail),
      commentCount: Option.match(fetched, { onNone: () => null, onSome: countAllComments }),
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

    // Diff comments against the cache before it is written, for the same subscribed pull requests.
    const commentNotifications: ReadonlyArray<NewNotification> = isSubscribed && Option.isSome(cachedPR) &&
        Option.isSome(fetched)
      ? yield* commentRepo.find(durableAccountId, prId, identity).pipe(
        Effect.catch(() => Effect.succeed(Option.none<ReadonlyArray<PRCommentLocation>>())),
        Effect.map(Option.match({
          onNone: () => [],
          onSome: (cachedComments) =>
            diffComments(
              cachedComments,
              fetched.value,
              prId,
              durableAccountId,
              identity.repositoryName,
              identity.accountRegion
            )
        }))
      )
      : []

    // Both groups from the read itself, so a merged or closed read keeps its merger and closing time.
    const written = yield* prRepo.upsertRead(freshUpsert, detail, observation).pipe(
      Effect.mapError((cause) => new RefreshError({ failedAccounts: [durableAccountId], cause }))
    )
    // Announced from the row this write replaced, read in the same transaction: an earlier snapshot
    // could be one another write has changed since. Only for the groups the cache took; a group not
    // written was older than the cache.
    const pending = isSubscribed
      ? Option.match(written.replaced, {
        onNone: () => [],
        onSome: (replaced) => [
          ...diffPR(replaced, freshUpsert, durableAccountId),
          // The cache keeps its last known rules while approval is unknown; compare once it recovers.
          ...(detail.approvalUnknown !== undefined ? [] : diffApprovalPools(
            replaced.approvalRules ?? [],
            freshUpsert.approvalRules,
            currentState.currentUser,
            prId,
            durableAccountId,
            detail.title,
            account.profile,
            identity.repositoryName,
            identity.accountRegion
          ))
        ]
      })
      : []
    yield* Effect.forEach(notificationsFor(pending, written), (n) => notificationRepo.add(n), { discard: true }).pipe(
      Effect.catch(() => Effect.void)
    )
    // The comment count is recomputed from this read, so it is written only to the row this refresh
    // just wrote; the comment cache and its notifications follow only when it was.
    const versions = written.versions
    const commentsWritten = written.row && versions !== undefined && Option.isSome(fetched)
      ? yield* prRepo.writeDerived(
        durableAccountId,
        prId,
        versions,
        { commentCount: countAllComments(fetched.value) },
        identity
      ).pipe(Effect.catch(() => Effect.succeed(false)))
      : false
    if (commentsWritten && Option.isSome(fetched)) {
      yield* commentRepo.upsert(durableAccountId, prId, JSON.stringify(fetched.value), identity).pipe(
        Effect.catch(() => Effect.void)
      )
      yield* Effect.forEach(commentNotifications, (n) => notificationRepo.add(n), { discard: true }).pipe(
        Effect.catch(() => Effect.void)
      )
    }
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
