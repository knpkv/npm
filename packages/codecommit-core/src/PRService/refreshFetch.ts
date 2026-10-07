/**
 * Phase 3 of the PR refresh cycle: streams PRs from AWS, diffs subscribed
 * PRs against cache (field changes via {@link diffPR} and approval pool
 * membership via {@link diffApprovalPools}), upserts to cache, and
 * transitions stale OPEN PRs by re-fetching their status.
 *
 * @internal
 */

import { Array as Arr, Cause, Effect, Option, Predicate, Ref, Stream, SubscriptionRef } from "effect"
import { AwsClient } from "../AwsClient/index.js"
import type { PullRequestDetail } from "../AwsClient/internal.js"
import { isCredentialInvalidCause } from "../AwsCredentialErrors.js"
import { diffApprovalPools, diffPR, notificationsFor } from "../CacheService/diff.js"
import { type NewNotification, NotificationRepo } from "../CacheService/repos/NotificationRepo.js"
import { type CachedPullRequest, PullRequestRepo } from "../CacheService/repos/PullRequestRepo/index.js"
import { SubscriptionRepo } from "../CacheService/repos/SubscriptionRepo.js"
import type { AccountConfig } from "../ConfigService/internal.js"
import { approvalUnknownReasonText, type PullRequestRefreshScope, type UnevaluatedPullRequest } from "../Domain.js"
import type { AwsClientError } from "../Errors.js"
import { applyIdentityEvent, IdentityEvent } from "../IdentityLifecycle.js"
import { type PRState, prToUpsertInput } from "./internal.js"
import { isSubscribedForCoordinates, subscriptionKey } from "./refreshResolve.js"

/** Whether a read failed because the provider says the pull request doesn't exist. */
const isPullRequestGone = (error: AwsClientError): boolean =>
  error._tag === "AwsApiError" && Predicate.isTagged(error.cause, "PullRequestDoesNotExistException")

/**
 * Whether a refresh failure means the account's credentials no longer work, decided from its type: a
 * credential failure, or a provider error saying so, directly or inside a failed approval evaluation.
 */
const isAuthFailure = (error: AwsClientError): boolean =>
  error._tag === "AwsCredentialError" ||
  (error._tag === "AwsApiError" && (
    isCredentialInvalidCause(error.cause) ||
    (Predicate.isTagged(error.cause, "ApprovalEvaluationError") && Predicate.hasProperty(error.cause, "cause") &&
      isCredentialInvalidCause(error.cause.cause))
  ))

const accountRegionKey = (profile: string, region: string): string => `${profile}\0${region}`

export const fetchAndUpsertPRs = (params: {
  readonly state: PRState
  readonly enabledAccounts: ReadonlyArray<AccountConfig>
  readonly accountIdMap: Map<string, string>
  readonly subscribedRef: Ref.Ref<Set<string>>
  readonly currentUser: string | undefined
  /** The refresh's identity generation, from `resolveAccounts`. */
  readonly identityGeneration: number
  readonly staleThreshold: string
}): Effect.Effect<
  ReadonlyArray<PullRequestRefreshScope>,
  never,
  AwsClient | PullRequestRepo | NotificationRepo | SubscriptionRepo
> =>
  Effect.gen(function*() {
    const awsClient = yield* AwsClient
    const prRepo = yield* PullRequestRepo
    const notificationRepo = yield* NotificationRepo
    const subscriptionRepo = yield* SubscriptionRepo

    const { accountIdMap, currentUser, enabledAccounts, identityGeneration, staleThreshold, state, subscribedRef } =
      params

    // Stale rows are safe to reconcile only when their owning list operation
    // completed successfully. A failed account stream says nothing about which
    // cached PRs remain open and must never turn into cache deletion.
    const successfullyFetchedScopes = yield* Ref.make(
      new Set(
        enabledAccounts.flatMap((account) =>
          accountIdMap.has(account.profile)
            ? (account.regions ?? []).map((region) => accountRegionKey(account.profile, region))
            : []
        )
      )
    )
    // A scope whose listing completed but where some pull requests' approval is unknown: its stale rows
    // still reconcile (the listing is complete), but the refresh does not count as successful.
    const partialScopes = yield* Ref.make(new Set<string>())
    const withholdScopeSuccess = (profile: string, region: string) =>
      Ref.update(successfullyFetchedScopes, (scopes) => {
        const next = new Set(scopes)
        next.delete(accountRegionKey(profile, region))
        return next
      })

    // The account's credentials stopped working during this refresh: an identity event of this
    // refresh's generation, so it does nothing once a newer refresh, login or logout has happened.
    const markAuthFailed = (profile: string) =>
      SubscriptionRef.update(
        state,
        (s) => applyIdentityEvent(s, IdentityEvent.RefreshAuthFailed({ generation: identityGeneration, profile }))
      )

    const accountLabels = enabledAccounts.flatMap((a) => (a.regions ?? []).map((r) => `${a.profile}(${r})`))
    yield* SubscriptionRef.update(state, (s) => ({
      ...s,
      statusDetail: accountLabels.join(", ")
    }))

    const streams = enabledAccounts.flatMap((account) =>
      (account.regions ?? []).map((region) => {
        const label = `${account.profile} (${region})`
        const awsAccountId = accountIdMap.get(account.profile) ?? ""
        // One observation for the whole listing, taken before it starts: a read that began later, of
        // the same revision, wins over it in the cache.
        return Stream.unwrap(
          prRepo.observe().pipe(
            Effect.map((observation) =>
              awsClient.getPullRequests({ profile: account.profile, region }).pipe(
                Stream.map((pr) => ({ awsAccountId, label, observation, pr, profile: account.profile, region })),
                Stream.catch((error) => {
                  const causeStr = (Predicate.isError(error)
                    ? error.name !== "Error" ? error.name : error.message
                    : String(error)) || "Unknown error"
                  const message = JSON.stringify({
                    operation: "getPullRequests",
                    profile: account.profile,
                    region,
                    cause: causeStr
                  })
                  const isAuthError = isAuthFailure(error) ||
                    /ExpiredToken|Unauthorized|AuthFailure|credentials/i.test(causeStr)
                  return Stream.fromEffectDrain(
                    Effect.gen(function*() {
                      yield* Ref.update(successfullyFetchedScopes, (scopes) => {
                        const next = new Set(scopes)
                        next.delete(accountRegionKey(account.profile, region))
                        return next
                      })
                      yield* notificationRepo.addSystem({
                        type: "error",
                        title: label,
                        message,
                        profile: account.profile,
                        deduplicate: true
                      }).pipe(Effect.catch(() => Effect.void))
                      // Typed first (credential failure, or a provider auth error), with the older text match as fallback.
                      if (isAuthError) yield* markAuthFailed(account.profile)
                    })
                  )
                })
              )
            ),
            Effect.catch((error) =>
              // Without an observation number the listing's writes couldn't be ordered: skip this scope.
              Effect.logWarning(`${label}: no observation number, listing skipped`, error).pipe(
                Effect.andThen(withholdScopeSuccess(account.profile, region)),
                Effect.as(Stream.empty)
              )
            )
          )
        )
      })
    )

    const unevaluated = yield* Ref.make<ReadonlyArray<UnevaluatedPullRequest>>([])
    // A stale row's re-read writes back everything it read: a closed or merged status, the details,
    // and the evaluation (a successful one replaces the last known approval; an unknown one marks the
    // row, lists it as unevaluated, and counts its scope as partial, as for a listed pull request).
    const recordStaleRead = (
      pr: {
        readonly awsAccountId: string
        readonly accountProfile: string
        readonly accountRegion: string
        readonly id: string
        readonly repositoryName: string
      },
      detail: PullRequestDetail,
      observation: number
    ) =>
      Effect.gen(function*() {
        const coordinates = { repositoryName: pr.repositoryName, accountRegion: pr.accountRegion }
        // The whole read, each group unless the cache holds a newer one: status, details, approval.
        const written = yield* prRepo.writeRead(pr.awsAccountId, pr.id, detail, observation, coordinates)
        const reason = detail.approvalUnknown
        // An approval group not written was older than the cache: its unknown approval isn't current.
        if (!written.approval || reason === undefined) {
          return
        }
        yield* Ref.update(
          partialScopes,
          (scopes) => new Set(scopes).add(accountRegionKey(pr.accountProfile, pr.accountRegion))
        )
        // A stale row is reconciled only for an enabled account's scope, which supplies its typed profile and region.
        for (const account of enabledAccounts.filter((a) => a.profile === pr.accountProfile)) {
          for (const region of (account.regions ?? []).filter((r) => r === pr.accountRegion)) {
            yield* Ref.update(unevaluated, (all) => [...all, {
              profile: account.profile,
              region,
              pullRequestId: pr.id,
              repositoryName: pr.repositoryName,
              message: approvalUnknownReasonText(reason)
            }])
          }
        }
      })

    yield* Stream.mergeAll(streams, { concurrency: 2 }).pipe(
      Stream.runForEach(({ awsAccountId, label, observation, pr, profile, region }) =>
        Effect.gen(function*() {
          // Diff subscribed PRs against cache. The notifications are sent only once the upsert applies:
          // a listing older than the cached row changes nothing, so it announces nothing.
          const pending: ReadonlyArray<NewNotification> = yield* Effect.gen(function*() {
            const subscribed = yield* Ref.get(subscribedRef)
            if (
              awsAccountId !== "" &&
              (yield* isSubscribedForCoordinates(
                prRepo,
                subscribed,
                awsAccountId,
                pr.id,
                pr.repositoryName,
                pr.account.region
              ))
            ) {
              const cached = yield* prRepo.findByCoordinates(
                awsAccountId,
                pr.id,
                pr.repositoryName,
                pr.account.region
              ).pipe(
                Effect.catch(() => Effect.succeed(Option.none<CachedPullRequest>()))
              )
              if (Option.isSome(cached)) {
                const notifications = diffPR(cached.value, prToUpsertInput(pr, awsAccountId), awsAccountId)
                // While approval is unknown the cache keeps its last known rules, so comparing them with
                // the fresh ones would repeat the same notification every refresh; membership is compared
                // once evaluation recovers.
                const poolNotifications = pr.approvalUnknown !== undefined ? [] : diffApprovalPools(
                  cached.value.approvalRules ?? [],
                  pr.approvalRules,
                  currentUser,
                  pr.id,
                  awsAccountId,
                  pr.title,
                  pr.account.profile,
                  pr.repositoryName,
                  pr.account.region
                )
                return [...notifications, ...poolNotifications]
              }
            }
            return []
          })

          // Upsert to cache + auto-subscribe current user's PRs
          if (awsAccountId !== "") {
            const written = yield* prRepo.upsert(prToUpsertInput(pr, awsAccountId), observation).pipe(
              Effect.tapError((e) => Effect.logWarning("cache upsert error", e)),
              Effect.catch(() =>
                withholdScopeSuccess(pr.account.profile, pr.account.region).pipe(
                  Effect.as({ row: false, approval: false })
                )
              )
            )
            // Everything below acts on what this read saw, so only for the groups the cache took: a
            // group not written was older than the cache, and what this read saw of it isn't current.
            const unknownReason = pr.approvalUnknown
            if (written.approval && unknownReason !== undefined) {
              // Upserted with its last known approval; the account's other pull requests carry on, and
              // its refresh counts as partial rather than successful.
              yield* Ref.update(unevaluated, (all) => [...all, {
                profile,
                region,
                pullRequestId: pr.id,
                repositoryName: pr.repositoryName,
                message: approvalUnknownReasonText(unknownReason)
              }])
              yield* Ref.update(partialScopes, (scopes) => new Set(scopes).add(accountRegionKey(profile, region)))
            }
            yield* Effect.forEach(notificationsFor(pending, written), (n) => notificationRepo.add(n), {
              discard: true
            }).pipe(Effect.catch(() => Effect.void))
            const isAuthor = currentUser !== undefined && currentUser !== "" && pr.author === currentUser
            const isApprover = currentUser !== undefined && currentUser !== "" &&
              pr.approvalRules.some((r) => r.poolMembers.includes(currentUser))
            if ((written.row && isAuthor) || (written.approval && isApprover)) {
              yield* subscriptionRepo.subscribe(awsAccountId, pr.id, {
                repositoryName: pr.repositoryName,
                accountRegion: pr.account.region
              }).pipe(Effect.catch(() => Effect.void))
              yield* Ref.update(
                subscribedRef,
                (s) => new Set(s).add(subscriptionKey(awsAccountId, pr.id, pr.repositoryName, pr.account.region))
              )
            }
          } else {
            yield* withholdScopeSuccess(pr.account.profile, pr.account.region)
          }

          yield* SubscriptionRef.update(state, (s) => ({
            ...s,
            statusDetail: `${label} #${pr.id} ${pr.repositoryName}`
          }))
        })
      )
    )

    // Transition stale OPEN PRs: re-fetch to discover if they were merged/closed
    const successfulScopes = yield* Ref.get(successfullyFetchedScopes)
    yield* prRepo.findStaleOpen(staleThreshold).pipe(
      Effect.flatMap((stalePRs) =>
        Effect.forEach(
          stalePRs.filter(
            (pr) =>
              accountIdMap.get(pr.accountProfile) === pr.awsAccountId &&
              successfulScopes.has(accountRegionKey(pr.accountProfile, pr.accountRegion))
          ),
          (pr) =>
            // The observation is taken before the read, so a read that began later wins in the cache.
            prRepo.observe().pipe(
              Effect.flatMap((observation) =>
                awsClient
                  .getPullRequest({
                    account: { profile: pr.accountProfile, region: pr.accountRegion },
                    pullRequestId: pr.id
                  })
                  .pipe(
                    Effect.matchEffect({
                      // Only the provider saying the pull request doesn't exist deletes its row (and leaves a
                      // tombstone). Credentials that stopped working mark the account; any other failure is
                      // no evidence it is gone, so the row stays for the next refresh.
                      onFailure: (error) =>
                        withholdScopeSuccess(pr.accountProfile, pr.accountRegion).pipe(
                          Effect.andThen(
                            isAuthFailure(error)
                              ? markAuthFailed(pr.accountProfile)
                              : isPullRequestGone(error)
                              ? prRepo.deleteOne(pr.awsAccountId, pr.id, observation, {
                                repositoryName: pr.repositoryName,
                                accountRegion: pr.accountRegion
                              }).pipe(Effect.catch(() => Effect.void))
                              : Effect.logWarning(
                                `stale pull request #${pr.id} could not be re-read; its row is kept`,
                                error
                              )
                          )
                        ),
                      // The provider proved it exists, so a failed cache write keeps the row and only withholds
                      // the scope's success.
                      onSuccess: (detail) =>
                        detail.repositoryName === pr.repositoryName
                          ? recordStaleRead(pr, detail, observation).pipe(
                            Effect.catch((error) =>
                              Effect.logWarning("stale pull request write failed", error).pipe(
                                Effect.andThen(withholdScopeSuccess(pr.accountProfile, pr.accountRegion))
                              )
                            )
                          )
                          : Effect.void
                    })
                  )
              ),
              Effect.catchTag("CacheError", (error) =>
                Effect.logWarning(`stale pull request #${pr.id}: no observation number, not re-read`, error).pipe(
                  Effect.andThen(withholdScopeSuccess(pr.accountProfile, pr.accountRegion))
                ))
            ),
          { concurrency: 5, discard: true }
        )
      ),
      Effect.catch(() => Ref.set(successfullyFetchedScopes, new Set()))
    )

    // Every refresh replaces the list, so a pull request that evaluates again drops off it. One
    // notification per profile, because system notifications deduplicate by profile.
    const unevaluatedPullRequests = yield* Ref.get(unevaluated)
    yield* SubscriptionRef.update(state, (s) => ({ ...s, unevaluatedPullRequests }))
    yield* Effect.forEach(
      Object.values(Arr.groupBy(unevaluatedPullRequests, ({ profile }) => profile)),
      (failures) => {
        const first = Arr.headNonEmpty(failures)
        const regions = [...new Set(failures.map(({ region }) => region))].join(", ")
        return notificationRepo.addSystem({
          type: "error",
          title: `${first.profile}: approval evaluation`,
          message: `${failures.length} pull request${
            failures.length === 1 ? "" : "s"
          } in ${regions} couldn't be re-evaluated, so their approval is unknown: ${first.message}`,
          profile: first.profile,
          replaceUnread: true
        }).pipe(Effect.catch(() => Effect.void))
      },
      { discard: true }
    )

    // Propagate repoAccountId from any PR that has it to all PRs that don't
    yield* prRepo.propagateRepoAccountId().pipe(Effect.catch(() => Effect.void))

    const partial = yield* Ref.get(partialScopes)
    const reconciledScopes = new Set(
      [...(yield* Ref.get(successfullyFetchedScopes))].filter((key) => !partial.has(key))
    )
    return enabledAccounts.flatMap((account) =>
      (account.regions ?? []).flatMap((region) => {
        const awsAccountId = accountIdMap.get(account.profile)
        return awsAccountId !== undefined && awsAccountId !== "" &&
            reconciledScopes.has(accountRegionKey(account.profile, region))
          ? [{ profile: account.profile, region, awsAccountId }]
          : []
      })
    )
  }).pipe(
    Effect.tapCauseIf(Cause.hasDies, (cause) => Effect.logWarning("fetchAndUpsertPRs failed", cause))
  )
