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
import { PullRequestRepo } from "../CacheService/repos/PullRequestRepo/index.js"
import { AwsProfileName, AwsRegion, type PRCommentLocation } from "../Domain.js"
import { countAllComments, type PRState } from "./internal.js"
import { isSubscribedForCoordinates } from "./refreshResolve.js"

const decodeAwsProfileName = Schema.decodeSync(AwsProfileName)
const decodeAwsRegion = Schema.decodeSync(AwsRegion)

const enrichSinglePR = (row: CachedPullRequest, subscribedSnapshot: Set<string>) =>
  Effect.gen(function*() {
    const awsClient = yield* AwsClient
    const commentRepo = yield* CommentRepo
    const notificationRepo = yield* NotificationRepo
    const prRepo = yield* PullRequestRepo

    const awsAccountId = row.awsAccountId
    const prId = row.id

    const locs = yield* awsClient.getCommentsForPullRequest({
      account: {
        profile: decodeAwsProfileName(row.accountProfile),
        region: decodeAwsRegion(row.accountRegion)
      },
      pullRequestId: prId,
      repositoryName: row.repositoryName
    }).pipe(Effect.catch(() => Effect.void.pipe(Effect.as(undefined))))

    if (locs !== undefined && awsAccountId !== "") {
      // Diff comments for subscribed PRs
      const coordinates = {
        repositoryName: row.repositoryName,
        accountRegion: row.accountRegion
      }
      if (
        yield* isSubscribedForCoordinates(
          prRepo,
          subscribedSnapshot,
          awsAccountId,
          prId,
          row.repositoryName,
          row.accountRegion
        )
      ) {
        const cachedComments = yield* commentRepo.find(awsAccountId, prId, coordinates).pipe(
          Effect.catch(() => Effect.succeed(Option.none<ReadonlyArray<PRCommentLocation>>()))
        )
        if (Option.isSome(cachedComments)) {
          const notifications = diffComments(
            cachedComments.value,
            locs,
            prId,
            awsAccountId,
            row.repositoryName,
            row.accountRegion
          )
          yield* Effect.forEach(notifications, (n) => notificationRepo.add(n), { discard: true }).pipe(
            Effect.catch(() => Effect.void)
          )
        }
      }
      // Cache comments
      yield* commentRepo.upsert(awsAccountId, prId, JSON.stringify(locs), coordinates).pipe(
        Effect.catch(() => Effect.void)
      )
    }

    // Fallback: use cached comment count from DB
    let commentCount = locs !== undefined ? countAllComments(locs) : 0
    if (locs === undefined && awsAccountId !== "") {
      const cached = yield* commentRepo.find(awsAccountId, prId, {
        repositoryName: row.repositoryName,
        accountRegion: row.accountRegion
      }).pipe(
        Effect.catch(() => Effect.succeed(Option.none<ReadonlyArray<PRCommentLocation>>()))
      )
      if (Option.isSome(cached)) {
        commentCount = countAllComments(cached.value)
      }
    }

    return awsAccountId !== ""
      ? Option.some({
        awsAccountId,
        commentCount,
        id: prId,
        repositoryName: row.repositoryName,
        accountRegion: row.accountRegion
      })
      : Option.none()
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

    const enrichments = yield* Effect.forEach(
      freshPRs,
      (row) =>
        Effect.gen(function*() {
          const result = yield* enrichSinglePR(row, subscribedSnapshot)
          const n = yield* Ref.updateAndGet(enrichedRef, (v) => v + 1)
          yield* SubscriptionRef.update(state, (s) => ({
            ...s,
            statusDetail: `fetching comments (${n}/${freshPRs.length})`
          }))
          return result
        }),
      { concurrency: 2 }
    )

    yield* Effect.forEach(
      enrichments,
      (r) =>
        Option.match(r, {
          onNone: () => Effect.void,
          onSome: ({ accountRegion, awsAccountId, commentCount, id, repositoryName }) =>
            prRepo.updateCommentCount(awsAccountId, id, commentCount, { repositoryName, accountRegion }).pipe(
              Effect.catch(() => Effect.void)
            )
        }),
      { discard: true }
    )

    // Derive commented_by from cached pr_comments
    yield* prRepo.refreshCommentedBy().pipe(
      Effect.catch(() => Effect.void)
    )
  }).pipe(
    Effect.tapCauseIf(Cause.hasDies, (cause) => Effect.logWarning("enrichComments failed", cause))
  )
