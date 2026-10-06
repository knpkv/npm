/**
 * @internal
 * Phases 1+2: Load cached PRs, resolve config/identity/subscriptions.
 */

import { Clock, DateTime, Effect, Match, Option, Ref, Result, Schema, SubscriptionRef } from "effect"
import { AwsClient, type CallerIdentity } from "../AwsClient/index.js"
import { isThrottlingError } from "../AwsClient/internal.js"
import { NotificationRepo } from "../CacheService/repos/NotificationRepo.js"
import { PullRequestRepo, type PullRequestRepoContract } from "../CacheService/repos/PullRequestRepo/index.js"
import { SubscriptionRepo } from "../CacheService/repos/SubscriptionRepo.js"
import { ConfigService } from "../ConfigService/index.js"
import type { AccountConfig } from "../ConfigService/internal.js"
import {
  type AppState,
  type AppStatus,
  AwsRegion,
  type CallerIdentityState,
  type CallerIdentityUnresolvedReason
} from "../Domain.js"
import type { AwsClientError } from "../Errors.js"
import { decodeCachedPR, type PRState } from "./internal.js"
import { enabledProfilesOf, retainEnabledAccountRows } from "./visibility.js"

export const subscriptionKey = (
  awsAccountId: string,
  pullRequestId: string,
  repositoryName?: string | null,
  accountRegion?: string | null
): string => `${awsAccountId}:${pullRequestId}:${repositoryName ?? ""}:${accountRegion ?? ""}`

/** Resolve a legacy subscription only when the account/PR pair identifies one exact cached row. */
export const isSubscribedForCoordinates = (
  prRepo: Pick<PullRequestRepoContract, "findByAccountAndId">,
  subscribed: ReadonlySet<string>,
  awsAccountId: string,
  pullRequestId: string,
  repositoryName: string,
  accountRegion: string
): Effect.Effect<boolean, never> => {
  if (subscribed.has(subscriptionKey(awsAccountId, pullRequestId, repositoryName, accountRegion))) {
    return Effect.succeed(true)
  }
  if (!subscribed.has(subscriptionKey(awsAccountId, pullRequestId))) return Effect.succeed(false)
  return prRepo.findByAccountAndId(awsAccountId, pullRequestId).pipe(
    Effect.map(Option.match({
      onNone: () => false,
      onSome: (row) => row.repositoryName === repositoryName && row.accountRegion === accountRegion
    })),
    Effect.catch(() => Effect.succeed(false))
  )
}

const decodeAwsRegion = Schema.decodeSync(AwsRegion)
const defaultAwsRegion = decodeAwsRegion("us-east-1")
const emptyAwsRegion = decodeAwsRegion("")
const loadingStatus: AppStatus = "loading"
const idleStatus: AppStatus = "idle"

const accountRegion = (region: string | undefined): AwsRegion =>
  region === undefined ? emptyAwsRegion : decodeAwsRegion(region)

const primaryRegion = (account: AccountConfig): AwsRegion => account.regions[0] ?? defaultAwsRegion

export interface ResolvedAccounts {
  readonly enabledAccounts: ReadonlyArray<AccountConfig>
  readonly accountIdMap: Map<string, string>
  readonly subscribedRef: Ref.Ref<Set<string>>
  readonly currentUser: string | undefined
}

const resolved = (identity: CallerIdentity): CallerIdentityState => ({
  _tag: "Resolved",
  accountId: identity.accountId,
  arn: identity.arn,
  username: identity.username
})

const unresolved = (reason: CallerIdentityUnresolvedReason): CallerIdentityState => ({ _tag: "Unresolved", reason })

/**
 * Why an identity lookup failed, decided by the error's type alone. Every AWS client error has a
 * reason and there is no default branch, so a new error type fails to compile until it gets one.
 */
export const unresolvedReasonOf = (error: AwsClientError): CallerIdentityUnresolvedReason =>
  Match.valueTags(error, {
    AwsCredentialError: (): CallerIdentityUnresolvedReason => ({ _tag: "CredentialsUnavailable" }),
    // The identity adapter wraps exhausted throttling in AwsApiError, so its cause decides.
    AwsApiError: (apiError): CallerIdentityUnresolvedReason =>
      isThrottlingError(apiError.cause) ? { _tag: "Throttled" } : { _tag: "StsRejected" },
    AwsThrottleError: (): CallerIdentityUnresolvedReason => ({ _tag: "Throttled" })
  })

/** Look up the caller in one account: record its AWS account id, and say who they are or why not. */
const resolveIdentity = (
  accountIdRef: Ref.Ref<Map<string, string>>,
  account: AccountConfig,
  region: AwsRegion,
  options?: {
    readonly updateCurrentUser?: (username: string) => Effect.Effect<void>
    readonly clearCurrentUser?: Effect.Effect<void>
  }
) =>
  Effect.gen(function*() {
    const awsClient = yield* AwsClient
    const notificationRepo = yield* NotificationRepo
    const { clearCurrentUser, updateCurrentUser } = options ?? {}

    const lookup = yield* awsClient.getCallerIdentity({
      profile: account.profile,
      region
    }).pipe(Effect.result)

    if (Result.isFailure(lookup)) {
      yield* notificationRepo.addSystem({
        type: "error",
        title: `${account.profile} (${region})`,
        message: "Failed to get caller identity — session may have expired",
        profile: account.profile,
        deduplicate: true
      })
      if (clearCurrentUser !== undefined) yield* clearCurrentUser
      return unresolved(unresolvedReasonOf(lookup.failure))
    }

    const identity = lookup.success
    yield* Ref.update(accountIdRef, (m) => new Map(m).set(account.profile, identity.accountId))
    if (updateCurrentUser !== undefined) yield* updateCurrentUser(identity.username)
    return resolved(identity)
  })

export const resolveAccounts = (state: PRState) =>
  Effect.gen(function*() {
    const configService = yield* ConfigService
    const prRepo = yield* PullRequestRepo
    const subscriptionRepo = yield* SubscriptionRepo

    // --- Phase 1: Load cached PRs immediately ---
    // Config first: the cache keeps rows for accounts the user switched off, and
    // they must not reappear in the published snapshot.
    const config = yield* configService.load.pipe(Effect.orDie)
    const enabled = enabledProfilesOf(config.accounts)
    const cachedPRs = retainEnabledAccountRows(
      yield* prRepo.findAll().pipe(Effect.catchIf(() => true, () => Effect.succeed([]))),
      enabled
    )

    yield* SubscriptionRef.update(state, ({ error: _, statusDetail: __, ...s }) => ({
      ...s,
      pullRequests: cachedPRs.map((row) => decodeCachedPR(row)),
      refreshGeneration: (s.refreshGeneration ?? 0) + 1,
      status: loadingStatus,
      successfulRefreshScopes: [],
      ...((cachedPRs.length > 0) && { statusDetail: "loading from cache..." })
    }))

    const detected = yield* configService.detectProfiles.pipe(Effect.catchIf(() => true, () => Effect.succeed([])))

    const accountsState = detected.map((d) => {
      const configured = config.accounts.find((a) => a.profile === d.name)
      return {
        profile: d.name,
        region: configured?.regions?.[0] ?? accountRegion(d.region),
        enabled: configured?.enabled ?? false
      }
    })

    yield* SubscriptionRef.update(state, (s) => ({ ...s, accounts: accountsState }))

    const enabledAccounts = config.accounts.filter((a) => a.enabled)

    if (enabledAccounts.length === 0) {
      const now = yield* Clock.currentTimeMillis
      yield* SubscriptionRef.update(
        state,
        // No account was refreshed, so none of the last refresh's unevaluated pull requests still apply.
        (s) => ({
          ...s,
          status: idleStatus,
          lastUpdated: DateTime.toDate(DateTime.makeUnsafe(now)),
          unevaluatedPullRequests: [],
          // A profile with no key is not enabled, so no identity, and no ARN, outlives disabling it.
          callerIdentities: {}
        })
      )
      return undefined
    }

    // --- Phase 2: Resolve AWS account IDs ---
    const accountIdRef = yield* Ref.make(new Map<string, string>())
    const [firstAccount, ...remainingAccounts] = enabledAccounts
    if (firstAccount === undefined) return undefined
    const firstRegion = primaryRegion(firstAccount)

    // A logout during resolution bumps the generation; then nothing this resolution found is published.
    const generationAtStart = (yield* SubscriptionRef.get(state)).identityGeneration ?? 0
    const unchangedSinceStart = (s: AppState) => (s.identityGeneration ?? 0) === generationAtStart
    // Each account's outcome is published as soon as its own lookup completes, so a failed account is
    // never shown with its old identity while slower accounts are still resolving.
    const publish = (profile: string) => (identity: CallerIdentityState) =>
      SubscriptionRef.update(state, (s) =>
        unchangedSinceStart(s) ? { ...s, callerIdentities: { ...s.callerIdentities, [profile]: identity } } : s)
    yield* resolveIdentity(
      accountIdRef,
      firstAccount,
      firstRegion,
      {
        clearCurrentUser: SubscriptionRef.update(state, (s) => {
          if (!unchangedSinceStart(s)) {
            return s
          }
          const { currentUser: _, ...rest } = s
          return rest
        }),
        updateCurrentUser: (username) =>
          SubscriptionRef.update(state, (s) =>
            unchangedSinceStart(s) ? { ...s, currentUser: username } : s)
      }
    ).pipe(Effect.flatMap(publish(firstAccount.profile)))
    yield* Effect.forEach(
      remainingAccounts,
      (account) =>
        resolveIdentity(accountIdRef, account, primaryRegion(account)).pipe(Effect.flatMap(publish(account.profile))),
      { concurrency: 3, discard: true }
    )
    // A profile with no key is not enabled: drop identities of accounts switched off since the last refresh.
    const enabledProfiles = new Set<string>(enabledAccounts.map((account) => account.profile))
    yield* SubscriptionRef.update(state, (s) =>
      unchangedSinceStart(s) && s.callerIdentities !== undefined
        ? {
          ...s,
          callerIdentities: Object.fromEntries(
            Object.entries(s.callerIdentities).filter(([profile]) => enabledProfiles.has(profile))
          )
        }
        : s)

    const accountIdMap = yield* Ref.get(accountIdRef)

    // Load subscriptions for diff
    const subscriptions = yield* subscriptionRepo.findAll().pipe(Effect.catchIf(() => true, () => Effect.succeed([])))
    const subscribedRef = yield* Ref.make(
      new Set(
        subscriptions.map((s) => subscriptionKey(s.awsAccountId, s.pullRequestId, s.repositoryName, s.accountRegion))
      )
    )
    const currentUser = (yield* SubscriptionRef.get(state)).currentUser

    return { accountIdMap, currentUser, enabledAccounts, subscribedRef } satisfies ResolvedAccounts
  })
