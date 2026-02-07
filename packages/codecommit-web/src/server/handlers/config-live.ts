import { HttpApiBuilder } from "@effect/platform"
import { ConfigService, PRService } from "@knpkv/codecommit-core"
import { Effect, SubscriptionRef } from "effect"
import { CodeCommitApi } from "../Api.js"

export const ConfigLive = HttpApiBuilder.group(CodeCommitApi, "config", (handlers) =>
  Effect.gen(function*() {
    const configService = yield* ConfigService.ConfigService
    const prService = yield* PRService.PRService

    return handlers.handle("list", () =>
      Effect.gen(function*() {
        const config = yield* configService.load.pipe(
          Effect.catchAll(() => Effect.succeed({ accounts: [], autoDetect: true }))
        )
        const state = yield* SubscriptionRef.get(prService.state)
        return {
          accounts: config.accounts.map((a) => ({
            profile: a.profile,
            regions: a.regions,
            enabled: a.enabled
          })),
          autoDetect: config.autoDetect,
          currentUser: state.currentUser
        }
      }))
  }))
