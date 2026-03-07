/**
 * @module StatsLive
 *
 * Mental model: HTTP handler group for the /stats API surface.
 * Maps HttpApi endpoints to StatsService calls. The "get" handler is
 * a synchronous query; the "sync" handler fires-and-forgets a background
 * fiber via Effect.forkDaemon for long-running historical re-sync.
 *
 * @category Server
 */
import { HttpApiBuilder } from "@effect/platform"
import { PRService } from "@knpkv/codecommit-core/PRService/index.js"
import { StatsService } from "@knpkv/codecommit-core/StatsService/index.js"
import { Effect } from "effect"
import { ApiError, CodeCommitApi } from "../Api.js"

export const StatsLive = HttpApiBuilder.group(CodeCommitApi, "stats", (handlers) =>
  Effect.gen(function*() {
    const statsService = yield* StatsService
    const prService = yield* PRService

    return handlers
      .handle("get", ({ urlParams }) =>
        statsService.getWeeklyStats(urlParams.week, {
          repo: urlParams.repo,
          author: urlParams.author,
          account: urlParams.account
        }).pipe(
          Effect.mapError((e) => new ApiError({ message: String(e) }))
        ))
      .handle("sync", ({ payload }) =>
        Effect.forkDaemon(
          statsService.syncWeek(payload.week, prService.state).pipe(
            Effect.tap(() => Effect.logInfo(`Sync ${payload.week} complete`)),
            Effect.tapErrorCause((cause) => Effect.logWarning(`Sync ${payload.week} failed`, cause))
          )
        ).pipe(
          Effect.as("sync started"),
          Effect.mapError((e) => new ApiError({ message: String(e) }))
        ))
  }))
