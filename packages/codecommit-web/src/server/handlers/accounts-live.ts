import { HttpApiBuilder } from "@effect/platform"
import { Chunk, Effect, SubscriptionRef } from "effect"
import { CodeCommitApi } from "../Api.js"
import { PRService, type Account } from "@knpkv/codecommit-core"

export const AccountsLive = HttpApiBuilder.group(CodeCommitApi, "accounts", (handlers) =>
  Effect.gen(function* () {
    const prService = yield* PRService

    return handlers.handle("list", () =>
      Effect.gen(function* () {
        const state = yield* SubscriptionRef.get(prService.state)
        const accounts: Account[] = state.accounts
          .filter((a) => a.enabled)
          .map((a) => ({
            id: a.profile,
            region: a.region
          }))
        return Chunk.fromIterable(accounts)
      })
    )
  })
)
