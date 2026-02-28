/**
 * @internal
 * Phases 1+2: Load cached PRs, resolve config/identity/subscriptions.
 */

import { Clock, DateTime, Effect, Ref, SubscriptionRef } from "effect"
import { AwsClient } from "../AwsClient/index.js"
import { NotificationRepo } from "../CacheService/repos/NotificationRepo.js"
import { PullRequestRepo } from "../CacheService/repos/PullRequestRepo.js"
import { SubscriptionRepo } from "../CacheService/repos/SubscriptionRepo.js"
import { ConfigService } from "../ConfigService/index.js"
import type { AccountConfig } from "../ConfigService/internal.js"
import type { AwsRegion } from "../Domain.js"
import { decodeCachedPR, type PRState } from "./internal.js"

export interface ResolvedAccounts {
  readonly enabledAccounts: ReadonlyArray<AccountConfig>
  readonly accountIdMap: Map<string, string>
  readonly subscribedRef: Ref.Ref<Set<string>>
  readonly currentUser: string | undefined
}

const resolveIdentity = (
  accountIdRef: Ref.Ref<Map<string, string>>,
  account: AccountConfig,
  region: string,
  options?: {
    readonly updateCurrentUser?: (username: string) => Effect.Effect<void>
    readonly clearCurrentUser?: Effect.Effect<void>
  }
) =>
  Effect.gen(function*() {
    const awsClient = yield* AwsClient
    const notificationRepo = yield* NotificationRepo
    const { clearCurrentUser, updateCurrentUser } = options ?? {}

    const identity = yield* awsClient.getCallerIdentity({
      profile: account.profile,
      region: region as AwsRegion
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))

    if (!identity) {
      yield* notificationRepo.addSystem({
        type: "error",
        title: `${account.profile} (${region})`,
        message: "Failed to get caller identity — session may have expired",
        profile: account.profile,
        deduplicate: true
      })
      if (clearCurrentUser) yield* clearCurrentUser
      return
    }

    yield* Ref.update(accountIdRef, (m) => new Map(m).set(account.profile, identity.accountId))
    if (updateCurrentUser) yield* updateCurrentUser(identity.username)
  })

export const resolveAccounts = (state: PRState) =>
  Effect.gen(function*() {
    const configService = yield* ConfigService
    const prRepo = yield* PullRequestRepo
    const subscriptionRepo = yield* SubscriptionRepo

    // --- Phase 1: Load cached PRs immediately ---
    const cachedPRs = yield* prRepo.findAll().pipe(Effect.catchAll(() => Effect.succeed([])))

    yield* SubscriptionRef.update(state, ({ error: _, statusDetail: __, ...s }) => ({
      ...s,
      pullRequests: cachedPRs.map(decodeCachedPR),
      status: "loading" as const,
      ...(cachedPRs.length > 0 ? { statusDetail: "loading from cache..." } : {})
    }))

    const config = yield* configService.load.pipe(Effect.orDie)
    const detected = yield* configService.detectProfiles.pipe(Effect.catchAll(() => Effect.succeed([])))

    const accountsState = detected.map((d) => {
      const configured = config.accounts.find((a) => a.profile === d.name)
      return {
        profile: d.name,
        region: configured?.regions?.[0] ?? d.region ?? ("" as AwsRegion),
        enabled: configured?.enabled ?? false
      }
    })

    yield* SubscriptionRef.update(state, (s) => ({ ...s, accounts: accountsState }))

    const enabledAccounts = config.accounts.filter((a) => a.enabled)

    if (enabledAccounts.length === 0) {
      const now = yield* Clock.currentTimeMillis
      yield* SubscriptionRef.update(
        state,
        (s) => ({ ...s, status: "idle" as const, lastUpdated: DateTime.toDate(DateTime.unsafeMake(now)) })
      )
      return undefined
    }

    // --- Phase 2: Resolve AWS account IDs ---
    const accountIdRef = yield* Ref.make(new Map<string, string>())
    const firstAccount = enabledAccounts[0]!
    const firstRegion = firstAccount.regions?.[0] ?? ("us-east-1" as AwsRegion)

    yield* resolveIdentity(
      accountIdRef,
      firstAccount,
      firstRegion,
      {
        clearCurrentUser: SubscriptionRef.update(state, ({ currentUser: _, ...rest }) => rest),
        updateCurrentUser: (username) => SubscriptionRef.update(state, (s) => ({ ...s, currentUser: username }))
      }
    )

    yield* Effect.forEach(
      enabledAccounts.slice(1),
      (account) => {
        const region = account.regions?.[0] ?? ("us-east-1" as AwsRegion)
        return resolveIdentity(accountIdRef, account, region)
      },
      { concurrency: 3 }
    )

    const accountIdMap = yield* Ref.get(accountIdRef)

    // Load subscriptions for diff
    const subscriptions = yield* subscriptionRepo.findAll().pipe(Effect.catchAll(() => Effect.succeed([])))
    const subscribedRef = yield* Ref.make(new Set(subscriptions.map((s) => `${s.awsAccountId}:${s.pullRequestId}`)))
    const currentUser = (yield* SubscriptionRef.get(state)).currentUser

    return { accountIdMap, currentUser, enabledAccounts, subscribedRef } satisfies ResolvedAccounts
  })
