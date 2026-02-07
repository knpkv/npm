/**
 * @internal
 */

import { Cause, Clock, DateTime, Effect, Stream, SubscriptionRef } from "effect"
import { AwsClient } from "../AwsClient/index.js"
import { ConfigService } from "../ConfigService/index.js"
import type { AwsRegion } from "../Domain.js"
import { NotificationsService } from "../NotificationsService.js"
import type { PRState } from "./internal.js"

export const makeRefresh = (
  state: PRState
): Effect.Effect<void, never, ConfigService | AwsClient | NotificationsService> =>
  Effect.gen(function*() {
    const configService = yield* ConfigService
    const awsClient = yield* AwsClient
    const notificationsService = yield* NotificationsService

    yield* SubscriptionRef.update(state, (s) => ({
      ...s,
      pullRequests: [],
      status: "loading" as const,
      error: undefined
    }))

    yield* notificationsService.clear

    const config = yield* configService.load.pipe(
      Effect.catchAll((e) => Effect.fail(new Error(`Config load failed: ${e.message}`)))
    )

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
      return
    }

    const firstAccount = enabledAccounts[0]!
    const firstRegion = firstAccount.regions?.[0] ?? ("us-east-1" as AwsRegion)
    yield* awsClient.getCallerIdentity({ profile: firstAccount.profile, region: firstRegion }).pipe(
      Effect.tap((user) => SubscriptionRef.update(state, (s) => ({ ...s, currentUser: user }))),
      Effect.catchAll(() => Effect.void)
    )

    const accountLabels = enabledAccounts.flatMap((a) => (a.regions ?? []).map((r) => `${a.profile}(${r})`))
    yield* SubscriptionRef.update(state, (s) => ({
      ...s,
      statusDetail: accountLabels.join(", ")
    }))

    const streams = enabledAccounts.flatMap((account) =>
      (account.regions ?? []).map((region) => {
        const label = `${account.profile} (${region})`
        return awsClient.getPullRequests({ profile: account.profile, region }).pipe(
          Stream.map((pr) => ({ pr, label })),
          Stream.catchAllCause((cause) => {
            const errorStr = Cause.pretty(cause).split("\n")[0] ?? "Unknown error"
            return Stream.fromEffect(
              notificationsService.add({
                type: "error" as const,
                title: label,
                message: errorStr
              })
            ).pipe(Stream.flatMap(() => Stream.empty))
          })
        )
      })
    )

    yield* Stream.mergeAll(streams, { concurrency: 2 }).pipe(
      Stream.runForEach(({ label, pr }) =>
        SubscriptionRef.update(state, (s) => {
          const prs = s.pullRequests
          const insertIdx = prs.findIndex((p) => p.creationDate.getTime() < pr.creationDate.getTime())
          const newPrs = insertIdx === -1 ? [...prs, pr] : [...prs.slice(0, insertIdx), pr, ...prs.slice(insertIdx)]
          return {
            ...s,
            pullRequests: newPrs,
            statusDetail: `${label} #${pr.id} ${pr.repositoryName}`
          }
        })
      )
    )

    const now = yield* Clock.currentTimeMillis
    yield* SubscriptionRef.update(state, (s) => ({
      ...s,
      status: "idle" as const,
      statusDetail: undefined,
      lastUpdated: DateTime.toDate(DateTime.unsafeMake(now))
    }))
  }).pipe(
    Effect.withSpan("PRService.refresh"),
    Effect.timeout("120 seconds"),
    Effect.catchAllCause((cause) => {
      const errorStr = Cause.pretty(cause).split("\n")[0] ?? "Unknown error"
      return SubscriptionRef.update(state, (s) => ({ ...s, status: "error" as const, error: errorStr }))
    })
  )
