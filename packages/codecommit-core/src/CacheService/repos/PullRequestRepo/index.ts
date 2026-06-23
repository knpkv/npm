/**
 * @module PullRequestRepo
 *
 * SQLite-backed cache for CodeCommit pull requests.
 * Assembles query methods from `./queries` and mutation methods from
 * `./mutations` into a single Effect.Service.
 *
 * @category CacheService
 */
import { Context, Effect, Layer } from "effect"
import type { Success } from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { DatabaseLive } from "../../Database.js"
import { EventsHub, RepoChange } from "../../EventsHub.js"
import { mutations } from "./mutations.js"
import * as Q from "./queries.js"

export { CachedPullRequest, type SearchResult, UpsertInput } from "./internal.js"
export type { CachedPullRequest as CachedPullRequestType } from "./internal.js"

const makePullRequestRepo = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const hub = yield* EventsHub
  const publish = hub.publish(RepoChange.PullRequests())

  return {
    findAll: Q.findAll(sql),
    findMissingDiffStats: Q.findMissingDiffStats(sql),
    findByAccountAndId: Q.findByAccountAndId(sql),
    search: Q.search(sql),
    findStaleOpen: Q.findStaleOpen(sql),
    findOpenInRange: Q.findOpenInRange(sql),
    ...mutations(sql, publish)
  } as const
})

export interface PullRequestRepoShape extends Success<typeof makePullRequestRepo> {}

export class PullRequestRepo extends Context.Service<
  PullRequestRepo,
  PullRequestRepoShape
>()("PullRequestRepo") {
  static readonly Default = Layer.effect(PullRequestRepo, makePullRequestRepo).pipe(
    Layer.provide(Layer.mergeAll(DatabaseLive, EventsHub.Default))
  )
}
