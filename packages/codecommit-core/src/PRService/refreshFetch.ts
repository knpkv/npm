/**
 * Phase 3 of the PR refresh cycle: streams PRs from AWS, diffs subscribed
 * PRs against cache (field changes via {@link diffPR} and approval pool
 * membership via {@link diffApprovalPools}), upserts to cache, and
 * transitions stale OPEN PRs by re-fetching their status.
 *
 * @internal
 */

import { Cause, Effect, Option, Ref, Stream, SubscriptionRef } from "effect"
import { AwsClient } from "../AwsClient/index.js"
import type { PullRequestDetail } from "../AwsClient/internal.js"
import { diffApprovalPools, diffPR } from "../CacheService/diff.js"
import { NotificationRepo } from "../CacheService/repos/NotificationRepo.js"
import { PullRequestRepo } from "../CacheService/repos/PullRequestRepo/index.js"
import { SubscriptionRepo } from "../CacheService/repos/SubscriptionRepo.js"
import type { AccountConfig } from "../ConfigService/internal.js"
import { type PRState, prToUpsertInput } from "./internal.js"

/** Resolve a stale OPEN PR: delete if still open, update status if merged/closed. */
const resolveStaleStatus = (
  prRepo: PullRequestRepo,
  detail: PullRequestDetail,
  awsAccountId: string,
  id: string
) =>
  detail.status === "OPEN"
    ? prRepo.deleteOne(awsAccountId, id)
    : prRepo.updateStatusAndClosedAt(
      awsAccountId,
      id,
      detail.status,
      detail.lastActivityDate.toISOString(),
      detail.mergedBy,
      detail.approvedBy
    )

export const fetchAndUpsertPRs = (params: {
  readonly state: PRState
  readonly enabledAccounts: ReadonlyArray<AccountConfig>
  readonly accountIdMap: Map<string, string>
  readonly subscribedRef: Ref.Ref<Set<string>>
  readonly currentUser: string | undefined
  readonly staleThreshold: string
}): Effect.Effect<
  void,
  never,
  AwsClient | PullRequestRepo | NotificationRepo | SubscriptionRepo
> =>
  Effect.gen(function*() {
    const awsClient = yield* AwsClient
    const prRepo = yield* PullRequestRepo
    const notificationRepo = yield* NotificationRepo
    const subscriptionRepo = yield* SubscriptionRepo

    const { accountIdMap, currentUser, enabledAccounts, staleThreshold, state, subscribedRef } = params

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
          Stream.map((pr) => ({ awsAccountId, label, pr })),
          Stream.catchAllCause((cause) => {
            const squashed = Cause.squash(cause)
            const causeStr = squashed instanceof Error
              ? (squashed.name !== "Error" ? squashed.name : squashed.message)
              : String(squashed) || "Unknown error"
            const message = JSON.stringify({
              operation: "getPullRequests",
              profile: account.profile,
              region,
              cause: causeStr
            })
            const isAuthError = /ExpiredToken|Unauthorized|AuthFailure|credentials/i.test(causeStr)
            return Stream.execute(
              Effect.gen(function*() {
                yield* notificationRepo.addSystem({
                  type: "error",
                  title: label,
                  message,
                  profile: account.profile,
                  deduplicate: true
                }).pipe(Effect.catchAll(() => Effect.void))
                if (isAuthError) {
                  yield* SubscriptionRef.update(state, ({ currentUser: _, ...rest }) => rest)
                }
              })
            )
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
              const poolNotifications = diffApprovalPools(
                cached.value.approvalRules ?? [],
                pr.approvalRules,
                currentUser,
                pr.id,
                awsAccountId,
                pr.title,
                pr.account.profile
              )
              yield* Effect.forEach([...notifications, ...poolNotifications], (n) => notificationRepo.add(n), {
                discard: true
              }).pipe(
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
            const isAuthor = currentUser && pr.author === currentUser
            const isApprover = currentUser && pr.approvalRules.some((r) => r.poolMembers.includes(currentUser))
            if (isAuthor || isApprover) {
              yield* subscriptionRepo.subscribe(awsAccountId, pr.id).pipe(Effect.catchAll(() => Effect.void))
              yield* Ref.update(subscribedRef, (s) => new Set(s).add(`${awsAccountId}:${pr.id}`))
            }
          }

          yield* SubscriptionRef.update(state, (s) => ({
            ...s,
            statusDetail: `${label} #${pr.id} ${pr.repositoryName}`
          }))
        })
      )
    )

    // Transition stale OPEN PRs: re-fetch to discover if they were merged/closed
    yield* prRepo.findStaleOpen(staleThreshold).pipe(
      Effect.flatMap((stalePRs) =>
        Effect.forEach(
          stalePRs,
          (pr) =>
            awsClient
              .getPullRequest({
                account: { profile: pr.accountProfile, region: pr.accountRegion },
                pullRequestId: pr.id
              })
              .pipe(
                Effect.flatMap((detail) => resolveStaleStatus(prRepo, detail, pr.awsAccountId, pr.id)),
                Effect.catchAll(() => prRepo.deleteOne(pr.awsAccountId, pr.id)),
                Effect.catchAll(() => Effect.void)
              ),
          { concurrency: 5, discard: true }
        )
      ),
      Effect.catchAll(() => Effect.void)
    )
  })
