import { HttpApiBuilder } from "@effect/platform"
import { Domain, PRService } from "@knpkv/codecommit-core"
import { Chunk, Effect, SubscriptionRef } from "effect"
import { CodeCommitApi } from "../Api.js"

export const AccountsLive = HttpApiBuilder.group(CodeCommitApi, "accounts", (handlers) =>
  Effect.gen(function*() {
    const prService = yield* PRService.PRService

    return handlers.handle("list", () =>
      Effect.gen(function*() {
        const state = yield* SubscriptionRef.get(prService.state)
        const accounts = state.accounts
          .filter((a) => a.enabled)
          .map((a) =>
            new Domain.Account({
              id: a.profile,
              region: a.region
            })
          )
        return Chunk.fromIterable(accounts)
      }))
  }))
