/**
 * Pull request orchestration service.
 *
 * @category Service
 * @module
 */
import { Context, Effect, Layer, SubscriptionRef } from "effect"
import type { AwsClient } from "../AwsClient/index.js"
import type { ConfigService } from "../ConfigService/index.js"
import type { AppState, AwsProfileName, NotificationType } from "../Domain.js"
import { NotificationsService } from "../NotificationsService.js"
import { makeRefresh } from "./refresh.js"
import { makeSetAllAccounts } from "./setAllAccounts.js"
import { makeToggleAccount } from "./toggleAccount.js"

// ---------------------------------------------------------------------------
// Service Definition
// ---------------------------------------------------------------------------

export class PRService extends Context.Tag("@knpkv/codecommit-core/PRService")<
  PRService,
  {
    readonly state: SubscriptionRef.SubscriptionRef<AppState>
    readonly refresh: Effect.Effect<void>
    readonly toggleAccount: (profile: AwsProfileName) => Effect.Effect<void>
    readonly setAllAccounts: (
      enabled: boolean,
      profiles?: Array<AwsProfileName>
    ) => Effect.Effect<void>
    readonly clearNotifications: Effect.Effect<void>
    readonly addNotification: (item: {
      readonly type: NotificationType
      readonly title: string
      readonly message: string
    }) => Effect.Effect<void>
  }
>() {}

// ---------------------------------------------------------------------------
// Live Implementation
// ---------------------------------------------------------------------------

export const PRServiceLive = Layer.effect(
  PRService,
  Effect.gen(function*() {
    const notificationsService = yield* NotificationsService
    const ctx = yield* Effect.context<ConfigService | AwsClient | NotificationsService>()

    const state = yield* SubscriptionRef.make<AppState>({
      pullRequests: [],
      accounts: [],
      status: "idle"
    })

    const provide = <A, E>(effect: Effect.Effect<A, E, ConfigService | AwsClient | NotificationsService>) =>
      Effect.provide(effect, ctx)

    const refresh = provide(makeRefresh(state))
    const toggleAccount = makeToggleAccount(state, refresh)
    const setAllAccounts = makeSetAllAccounts(state, refresh)

    return {
      state,
      refresh,
      toggleAccount: (p) => provide(toggleAccount(p)),
      setAllAccounts: (e, ps) => provide(setAllAccounts(e, ps)),
      clearNotifications: notificationsService.clear,
      addNotification: notificationsService.add
    }
  })
)
