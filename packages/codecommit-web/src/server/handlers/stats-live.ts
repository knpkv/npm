/**
 * @module StatsLive
 *
 * Mental model: HTTP handler group for the /stats API surface.
 * Maps HttpApi endpoints to StatsService calls. The "get" handler is
 * a synchronous query; the "sync" handler fires-and-forgets a background
 * fiber via Effect.forkDetach for long-running historical re-sync.
 *
 * @category Server
 */
import { PRService } from "@knpkv/codecommit-core/PRService/index.js"
import { StatsService } from "@knpkv/codecommit-core/StatsService/index.js"
import { Effect, Ref } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiError, CodeCommitApi } from "../Api.js"

export const StatsLive = HttpApiBuilder.group(CodeCommitApi, "stats", (handlers) =>
  Effect.gen(function*() {
    const statsService = yield* StatsService
    const prService = yield* PRService
    const syncing = yield* Ref.make(false)

    return handlers
      .handle("get", ({ query }) =>
        statsService.getWeeklyStats(query.week, {
          repo: query.repo,
          author: query.author,
          account: query.account
        }).pipe(
          Effect.mapError((e) => new ApiError({ message: String(e) }))
        ))
      .handle("sync", ({ payload }) =>
        Ref.get(syncing).pipe(
          Effect.flatMap((inProgress) =>
            inProgress
              ? Effect.succeed("sync already in progress")
              : Ref.set(syncing, true).pipe(
                Effect.flatMap(() =>
                  Effect.forkDetach(
                    statsService.syncWeek(payload.week, prService.state).pipe(
                      Effect.tap(() => Effect.logInfo(`Sync ${payload.week} complete`)),
                      Effect.tapCause((cause) => Effect.logWarning(`Sync ${payload.week} failed`, cause)),
                      Effect.ensuring(Ref.set(syncing, false))
                    )
                  ).pipe(Effect.as("sync started"))
                )
              )
          ),
          Effect.mapError((e) => new ApiError({ message: String(e) }))
        ))
  }))
