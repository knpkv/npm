/**
 * @module refreshHistory
 *
 * Mental model: On-demand historical sync. Three phases:
 * 1. Fetch current OPEN PRs from AWS into cache
 * 2. Re-check cached OPEN PRs to discover merged/closed transitions
 * 3. Compute commented_by from pr_comments
 *
 * Think of it as a "catch-up" job that fills gaps the live polling can't cover.
 *
 * @internal
 */

import { Effect, Option, Ref, Stream, SubscriptionRef } from "effect"
import { AwsClient } from "../AwsClient/index.js"
import { PullRequestRepo } from "../CacheService/repos/PullRequestRepo/index.js"
import { ConfigService } from "../ConfigService/index.js"
import { parseISOWeek } from "../DateUtils.js"
import { decodeCachedPR, type PRState, prToUpsertInput } from "./internal.js"

export const syncWeek = Effect.fn("syncWeek")(
  function*(state: PRState, week: string) {
    yield* Effect.gen(function*() {
      const range = Option.getOrUndefined(parseISOWeek(week))
      if (!range) {
        yield* Effect.logWarning(`syncWeek: invalid week format "${week}"`)
        return
      }

      const awsClient = yield* AwsClient
      const prRepo = yield* PullRequestRepo
      const configService = yield* ConfigService

      const config = yield* configService.load.pipe(
        Effect.catchAll(() => Effect.succeed(undefined))
      )
      if (!config) {
        yield* Effect.logWarning("syncWeek: no config found")
        return
      }

      const enabledAccounts = config.accounts.filter((a: { enabled: boolean }) => a.enabled)
      yield* Effect.logInfo(`syncWeek ${week}: ${enabledAccounts.length} accounts`)

      yield* SubscriptionRef.update(state, (s) => ({
        ...s,
        status: "loading" as const,
        statusDetail: `syncing ${week}`
      }))

      // Phase 1: Fetch current OPEN PRs from AWS to populate cache
      const fetchedRef = yield* Ref.make(0)
      const accountRegions = enabledAccounts.flatMap((account) =>
        account.regions.map((region) => ({ account, region }))
      )

      yield* Effect.forEach(
        accountRegions,
        ({ account, region }) =>
          Effect.gen(function*() {
            const label = `${account.profile} (${region})`
            yield* SubscriptionRef.update(state, (s) => ({
              ...s,
              statusDetail: `syncing ${week} — ${label} fetching PRs`
            }))

            const identity = yield* awsClient
              .getCallerIdentity({ profile: account.profile, region })
              .pipe(
                Effect.catchAll(() => Effect.succeed({ accountId: account.profile as string, arn: "" }))
              )
            const awsAccountId = identity.accountId

            yield* awsClient
              .getPullRequests({ profile: account.profile, region })
              .pipe(
                Stream.runForEach((pr) =>
                  prRepo.upsert(prToUpsertInput(pr, awsAccountId)).pipe(
                    Effect.tap(() =>
                      Ref.updateAndGet(fetchedRef, (n) => n + 1).pipe(
                        Effect.flatMap((n) =>
                          SubscriptionRef.update(state, (s) => ({
                            ...s,
                            statusDetail: `syncing ${week} — ${label} (${n} PRs)`
                          }))
                        )
                      )
                    ),
                    Effect.catchAll(() => Effect.void)
                  )
                ),
                Effect.catchAll((e) => Effect.logWarning("sync fetch error", e))
              )
          }),
        { discard: true }
      )

      const fetched = yield* Ref.get(fetchedRef)
      yield* Effect.logInfo(`syncWeek ${week}: Phase 1 done — ${fetched} PRs fetched`)

      // Phase 2: Re-check all cached OPEN PRs to discover merged/closed ones
      yield* SubscriptionRef.update(state, (s) => ({
        ...s,
        statusDetail: `syncing ${week} — checking PR statuses`
      }))

      const openPRs = yield* prRepo.findStaleOpen("9999-12-31T23:59:59Z").pipe(
        Effect.catchAll(() => Effect.succeed([]))
      )

      const transitionedRef = yield* Ref.make(0)
      yield* Effect.forEach(
        openPRs,
        (pr) =>
          awsClient
            .getPullRequest({
              account: { profile: pr.accountProfile, region: pr.accountRegion },
              pullRequestId: pr.id
            })
            .pipe(
              Effect.flatMap((detail) => {
                if (detail.status !== "OPEN") {
                  return prRepo
                    .updateStatusAndClosedAt(
                      pr.awsAccountId,
                      pr.id,
                      detail.status,
                      new Date().toISOString(),
                      detail.mergedBy,
                      detail.approvedBy
                    )
                    .pipe(
                      Effect.tap(() =>
                        Ref.updateAndGet(transitionedRef, (n) => n + 1).pipe(
                          Effect.flatMap((n) =>
                            SubscriptionRef.update(state, (s) => ({
                              ...s,
                              statusDetail: `syncing ${week} — ${n} status updates`
                            }))
                          )
                        )
                      )
                    )
                }
                return Effect.void
              }),
              Effect.catchAll(() => Effect.void)
            ),
        { concurrency: 5, discard: true }
      )

      const transitioned = yield* Ref.get(transitionedRef)
      yield* Effect.logInfo(`syncWeek ${week}: Phase 2 done — ${openPRs.length} checked, ${transitioned} transitioned`)

      // Phase 3: Compute commented_by from pr_comments
      yield* SubscriptionRef.update(state, (s) => ({
        ...s,
        statusDetail: `syncing ${week} — computing commenters`
      }))
      yield* prRepo.refreshCommentedBy().pipe(
        Effect.catchAll((e) => Effect.logWarning("refreshCommentedBy failed", e))
      )

      // Reload PRs from DB so SSE clients get fresh data (incl. approvedBy, commentedBy)
      const freshPRs = yield* prRepo.findAll().pipe(
        Effect.map((rows) => rows.map((r) => decodeCachedPR(r))),
        Effect.catchAll(() => Effect.succeed([] as Array<ReturnType<typeof decodeCachedPR>>))
      )

      yield* SubscriptionRef.update(state, ({ statusDetail: _, ...s }) => ({
        ...s,
        status: "idle" as const,
        pullRequests: freshPRs
      }))
    }).pipe(
      Effect.catchAll((e) =>
        Effect.gen(function*() {
          yield* Effect.logWarning("syncWeek failed", e)
          yield* SubscriptionRef.update(state, (s) => ({
            ...s,
            status: "error" as const,
            error: `History sync failed: ${String(e)}`
          }))
        })
      )
    )
  }
)
