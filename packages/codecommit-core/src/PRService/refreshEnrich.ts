/**
 * @internal
 * Phase 4: Fetch comments for each PR, diff, cache, and count.
 */

import { Cause, Effect, Option, Ref, Schema, SubscriptionRef } from "effect"
import { AwsClient } from "../AwsClient/index.js"
import { diffComments } from "../CacheService/diff.js"
import { CommentRepo } from "../CacheService/repos/CommentRepo.js"
import { NotificationRepo } from "../CacheService/repos/NotificationRepo.js"
import type { CachedPullRequest } from "../CacheService/repos/PullRequestRepo/index.js"
import { PullRequestRepo, versionsOf } from "../CacheService/repos/PullRequestRepo/index.js"
import { AwsProfileName, AwsRegion, type PRCommentLocation } from "../Domain.js"
import { countAllComments, type PRState } from "./internal.js"
import { isSubscribedForCoordinates } from "./refreshResolve.js"

const decodeAwsProfileName = Schema.decodeSync(AwsProfileName)
const decodeAwsRegion = Schema.decodeSync(AwsRegion)

/**
 * Fetch one pull request's comments, then write their count and cache them, and announce what changed.
 * The count is recomputed from the row as it was read, so it is written only while that row still
 * holds the versions it was read at; the comment cache and the notifications follow only when it was.
 */
const enrichSinglePR = (row: CachedPullRequest, subscribedSnapshot: Set<string>) =>
  Effect.gen(function*() {
    const awsClient = yield* AwsClient
    const commentRepo = yield* CommentRepo
    const notificationRepo = yield* NotificationRepo
    const prRepo = yield* PullRequestRepo

    const awsAccountId = row.awsAccountId
    const prId = row.id
    if (awsAccountId === "") return
    const coordinates = { repositoryName: row.repositoryName, accountRegion: row.accountRegion }

    const locs = yield* awsClient.getCommentsForPullRequest({
      account: {
        profile: decodeAwsProfileName(row.accountProfile),
        region: decodeAwsRegion(row.accountRegion)
      },
      pullRequestId: prId,
      repositoryName: row.repositoryName
    }).pipe(Effect.catch(() => Effect.void.pipe(Effect.as(undefined))))

    const cachedComments = yield* commentRepo.find(awsAccountId, prId, coordinates).pipe(
      Effect.catch(() => Effect.succeed(Option.none<ReadonlyArray<PRCommentLocation>>()))
    )
    // Without a fresh fetch, the count falls back to the cached comments.
    const commentCount = locs !== undefined
      ? countAllComments(locs)
      : Option.match(cachedComments, { onNone: () => 0, onSome: countAllComments })
    const subscribed = yield* isSubscribedForCoordinates(
      prRepo,
      subscribedSnapshot,
      awsAccountId,
      prId,
      row.repositoryName,
      row.accountRegion
    )
    const notifications = locs !== undefined && subscribed && Option.isSome(cachedComments)
      ? diffComments(cachedComments.value, locs, prId, awsAccountId, row.repositoryName, row.accountRegion)
      : []

    const written = yield* prRepo.writeDerived(awsAccountId, prId, versionsOf(row), { commentCount }, coordinates).pipe(
      Effect.catch(() => Effect.succeed(false))
    )
    if (!written || locs === undefined) return
    yield* commentRepo.upsert(awsAccountId, prId, JSON.stringify(locs), coordinates).pipe(
      Effect.catch(() => Effect.void)
    )
    yield* Effect.forEach(notifications, (n) => notificationRepo.add(n), { discard: true }).pipe(
      Effect.catch(() => Effect.void)
    )
  })

export const enrichComments = (params: {
  readonly state: PRState
  readonly subscribedRef: Ref.Ref<Set<string>>
}): Effect.Effect<void, never, AwsClient | CommentRepo | NotificationRepo | PullRequestRepo> =>
  Effect.gen(function*() {
    const prRepo = yield* PullRequestRepo

    const { state, subscribedRef } = params

    const freshPRs = yield* prRepo.findAll().pipe(Effect.catch(() => Effect.succeed<Array<CachedPullRequest>>([])))
    const subscribedSnapshot = yield* Ref.get(subscribedRef)
    const enrichedRef = yield* Ref.make(0)

    yield* SubscriptionRef.update(state, (s) => ({
      ...s,
      statusDetail: `fetching comments (0/${freshPRs.length})`
    }))

    yield* Effect.forEach(
      freshPRs,
      (row) =>
        Effect.gen(function*() {
          yield* enrichSinglePR(row, subscribedSnapshot)
          const n = yield* Ref.updateAndGet(enrichedRef, (v) => v + 1)
          yield* SubscriptionRef.update(state, (s) => ({
            ...s,
            statusDetail: `fetching comments (${n}/${freshPRs.length})`
          }))
        }),
      { concurrency: 2, discard: true }
    )

    // Derive commented_by from cached pr_comments
    yield* prRepo.refreshCommentedBy().pipe(
      Effect.catch(() => Effect.void)
    )
  }).pipe(
    Effect.tapCauseIf(Cause.hasDies, (cause) => Effect.logWarning("enrichComments failed", cause))
  )
