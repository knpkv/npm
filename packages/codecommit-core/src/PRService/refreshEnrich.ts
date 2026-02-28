/**
 * @internal
 * Phase 4: Fetch comments for each PR, diff, cache, and count.
 */

import { Effect, Option, Ref, SubscriptionRef } from "effect"
import { AwsClient } from "../AwsClient/index.js"
import { diffComments } from "../CacheService/diff.js"
import { CommentRepo } from "../CacheService/repos/CommentRepo.js"
import { NotificationRepo } from "../CacheService/repos/NotificationRepo.js"
import type { CachedPullRequest } from "../CacheService/repos/PullRequestRepo.js"
import { PullRequestRepo } from "../CacheService/repos/PullRequestRepo.js"
import type { AwsProfileName, AwsRegion } from "../Domain.js"
import { countAllComments, type PRState } from "./internal.js"

const enrichSinglePR = (row: CachedPullRequest, subscribedSnapshot: Set<string>) =>
  Effect.gen(function*() {
    const awsClient = yield* AwsClient
    const commentRepo = yield* CommentRepo
    const notificationRepo = yield* NotificationRepo

    const awsAccountId = row.awsAccountId
    const prId = row.id

    const locs = yield* awsClient.getCommentsForPullRequest({
      account: {
        profile: row.accountProfile as AwsProfileName,
        region: row.accountRegion as AwsRegion
      },
      pullRequestId: prId,
      repositoryName: row.repositoryName
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))

    if (locs && awsAccountId) {
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
    }

    // Fallback: use cached comment count from DB
    let commentCount = locs ? countAllComments(locs) : 0
    if (!locs && awsAccountId) {
      const cached = yield* commentRepo.find(awsAccountId, prId).pipe(
        Effect.catchAll(() => Effect.succeed(Option.none()))
      )
      if (Option.isSome(cached)) {
        commentCount = countAllComments(cached.value)
      }
    }

    return awsAccountId ? Option.some({ awsAccountId, commentCount, id: prId }) : Option.none()
  })

export const enrichComments = (params: {
  readonly state: PRState
  readonly subscribedRef: Ref.Ref<Set<string>>
}): Effect.Effect<void, never, AwsClient | PullRequestRepo | CommentRepo | NotificationRepo> =>
  Effect.gen(function*() {
    const prRepo = yield* PullRequestRepo

    const { state, subscribedRef } = params

    const freshPRs = yield* prRepo.findAll().pipe(Effect.catchAll(() => Effect.succeed([])))
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
          onSome: ({ awsAccountId, commentCount, id }) =>
            prRepo.updateCommentCount(awsAccountId, id, commentCount).pipe(
              Effect.catchAll(() => Effect.void)
            )
        }),
      { discard: true }
    )
  })
