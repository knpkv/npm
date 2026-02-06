import type { HttpClient } from "@effect/platform"
import { Cause, Context, Effect, Layer, Ref, Stream, SubscriptionRef } from "effect"
import { AwsClient } from "./AwsClient.js"
import { ConfigService } from "./ConfigService.js"
import type { PullRequest } from "./Domain.js"
import { type NotificationItem, NotificationsService } from "./NotificationsService.js"

export interface AppState {
  readonly pullRequests: ReadonlyArray<PullRequest>
  readonly accounts: ReadonlyArray<{
    readonly profile: string
    readonly region: string
    readonly enabled: boolean
  }>
  readonly status: "idle" | "loading" | "error"
  readonly statusDetail?: string | undefined
  readonly error?: string | undefined
  readonly lastUpdated?: Date
  readonly currentUser?: string
}

export class PRService extends Context.Tag("PRService")<
  PRService,
  {
    readonly state: SubscriptionRef.SubscriptionRef<AppState>
    readonly refresh: Effect.Effect<void, never, HttpClient.HttpClient>
    readonly toggleAccount: (profile: string) => Effect.Effect<void, never, HttpClient.HttpClient>
    readonly setAllAccounts: (
      enabled: boolean,
      profiles?: Array<string>
    ) => Effect.Effect<void, never, HttpClient.HttpClient>
    readonly clearNotifications: Effect.Effect<void>
    readonly addNotification: (item: Omit<NotificationItem, "timestamp">) => Effect.Effect<void>
  }
>() {}

export const PRServiceLive = Layer.effect(
  PRService,
  Effect.gen(function*() {
    const configService = yield* ConfigService
    const awsClient = yield* AwsClient
    const notificationsService = yield* NotificationsService

    const state = yield* SubscriptionRef.make<AppState>({
      pullRequests: [],
      accounts: [],
      status: "idle"
    })

    const refresh: Effect.Effect<void, never, HttpClient.HttpClient> = Effect.gen(function*() {
      yield* SubscriptionRef.update(state, (s) => ({
        ...s,
        status: "loading" as const,
        error: undefined
      }))

      yield* notificationsService.clear // Clear notifications on refresh? Or keep history?
      // User said "implements notifications count". Usually we clear on refresh or allow manual clear.
      // But if errors happen during refresh, we add them.
      // I'll clear them for now to match old behavior.

      const config = yield* configService.load.pipe(
        Effect.catchAll((e) => Effect.fail(new Error(`Config load failed: ${e.message}`)))
      )

      // Get detected profiles to show in settings even if not in config
      const detected = yield* configService.detectProfiles.pipe(Effect.catchAll(() => Effect.succeed([])))

      const accountsState = detected.map((d) => {
        const configured = config.accounts.find((a) => a.profile === d.name)
        return {
          profile: d.name,
          region: configured?.regions?.[0] ?? d.region,
          enabled: configured?.enabled ?? false
        }
      })

      yield* SubscriptionRef.update(state, (s) => ({ ...s, accounts: accountsState }))

      const enabledAccounts = config.accounts.filter((a) => a.enabled)

      if (enabledAccounts.length === 0) {
        yield* SubscriptionRef.update(
          state,
          (s) => ({ ...s, status: "idle" as const, lastUpdated: new Date() })
        )
        return
      }

      // Get current user identity from first enabled account
      const firstAccount = enabledAccounts[0]!
      const firstRegion = firstAccount.regions?.[0] ?? "us-east-1"
      yield* awsClient.getCallerIdentity({ profile: firstAccount.profile, region: firstRegion }).pipe(
        Effect.tap((user) => SubscriptionRef.update(state, (s) => ({ ...s, currentUser: user }))),
        Effect.catchAll(() => Effect.void)
      )

      const streams = enabledAccounts.flatMap((account) =>
        (account.regions ?? ["us-east-1"]).map((region) => {
          const label = `${account.profile} (${region})`
          return Stream.fromEffect(
            SubscriptionRef.update(state, (s) => ({ ...s, statusDetail: label }))
          ).pipe(
            Stream.flatMap(() => awsClient.getPullRequests({ profile: account.profile, region })),
            Stream.catchAllCause((cause) => {
              const errorStr = Cause.pretty(cause).split("\n")[0] ?? "Unknown error"
              return Stream.fromEffect(
                notificationsService.add({
                  type: "error",
                  title: label,
                  message: errorStr
                })
              ).pipe(Stream.flatMap(() => Stream.empty))
            })
          )
        })
      )

      // Collect new PRs, keeping old ones visible during fetch
      const newPRsRef = yield* Ref.make<Array<PullRequest>>([])
      yield* Stream.mergeAll(streams, { concurrency: "unbounded" }).pipe(
        Stream.runForEach((pr) =>
          Ref.update(newPRsRef, (prs) => {
            // Insert PR in sorted order (newest first)
            const insertIdx = prs.findIndex((p) => p.creationDate.getTime() < pr.creationDate.getTime())
            if (insertIdx === -1) {
              return [...prs, pr]
            }
            const newPrs = [...prs]
            newPrs.splice(insertIdx, 0, pr)
            return newPrs
          })
        )
      )

      // Swap in new PRs only after all fetched
      const newPRs = yield* Ref.get(newPRsRef)
      yield* SubscriptionRef.update(state, (s) => ({
        ...s,
        pullRequests: newPRs,
        status: "idle" as const,
        statusDetail: undefined,
        lastUpdated: new Date()
      }))
    }).pipe(
      Effect.timeout("120 seconds"),
      Effect.catchAllCause((cause) => {
        const errorStr = Cause.pretty(cause).split("\n")[0] ?? "Unknown error"
        return SubscriptionRef.update(state, (s) => ({ ...s, status: "error" as const, error: errorStr }))
      })
    )

    const toggleAccount = (profile: string): Effect.Effect<void, never, HttpClient.HttpClient> =>
      Effect.gen(function*() {
        const config = yield* configService.load.pipe(Effect.orDie)
        const existingIdx = config.accounts.findIndex((a) => a.profile === profile)

        const newAccounts = [...config.accounts]
        if (existingIdx >= 0) {
          newAccounts[existingIdx] = {
            ...newAccounts[existingIdx]!,
            enabled: !newAccounts[existingIdx]!.enabled
          }
        } else {
          const detected = yield* configService.detectProfiles.pipe(Effect.orDie)
          const p = detected.find((d) => d.name === profile)
          newAccounts.push({
            profile,
            regions: [p?.region ?? "us-east-1"],
            enabled: true
          })
        }

        yield* configService.save({ ...config, accounts: newAccounts }).pipe(Effect.orDie)
        yield* refresh
      })

    const setAllAccounts = (
      enabled: boolean,
      profiles?: Array<string>
    ): Effect.Effect<void, never, HttpClient.HttpClient> =>
      Effect.gen(function*() {
        const config = yield* configService.load.pipe(Effect.orDie)
        const detected = yield* configService.detectProfiles.pipe(Effect.orDie)
        const targetProfiles = profiles ?? detected.map((d) => d.name)

        const newAccounts = targetProfiles.map((profile) => {
          const existing = config.accounts.find((a) => a.profile === profile)
          const det = detected.find((d) => d.name === profile)
          return {
            profile,
            regions: existing?.regions ?? [det?.region ?? "us-east-1"],
            enabled
          }
        })

        yield* configService.save({ ...config, accounts: newAccounts }).pipe(Effect.orDie)
        yield* refresh
      })

    const clearNotifications = notificationsService.clear
    const addNotification = notificationsService.add

    return { state, refresh, toggleAccount, setAllAccounts, clearNotifications, addNotification }
  })
)
