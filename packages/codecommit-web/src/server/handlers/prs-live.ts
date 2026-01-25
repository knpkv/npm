import { HttpApiBuilder, HttpClient } from "@effect/platform"
import { Chunk, Effect, SubscriptionRef } from "effect"
import { CodeCommitApi } from "../Api.js"
import { PRService } from "@knpkv/codecommit-core"

export const PrsLive = HttpApiBuilder.group(CodeCommitApi, "prs", (handlers) =>
  Effect.gen(function* () {
    const prService = yield* PRService
    const httpClient = yield* HttpClient.HttpClient

    return handlers
      .handle("list", () =>
        SubscriptionRef.get(prService.state).pipe(
          Effect.map((state) => Chunk.fromIterable(state.pullRequests))
        )
      )
      .handle("refresh", () =>
        prService.refresh.pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.map(() => "ok")
        )
      )
      .handle("create", () => Effect.succeed("stub-pr-id"))
  })
)
