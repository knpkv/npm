/**
 * @module PullRequestRepo
 *
 * SQLite-backed cache for CodeCommit pull requests.
 * Assembles query methods from `./queries` and mutation methods from
 * `./mutations` into a single Effect.Service.
 *
 * @category CacheService
 */
import * as SqlClient from "@effect/sql/SqlClient"
import { Effect } from "effect"
import { DatabaseLive } from "../../Database.js"
import { EventsHub, RepoChange } from "../../EventsHub.js"
import { mutations } from "./mutations.js"
import * as Q from "./queries.js"

export { CachedPullRequest, type SearchResult, UpsertInput } from "./internal.js"
export type { CachedPullRequest as CachedPullRequestType } from "./internal.js"

export class PullRequestRepo extends Effect.Service<PullRequestRepo>()("PullRequestRepo", {
  dependencies: [DatabaseLive, EventsHub.Default],
  effect: Effect.gen(function*() {
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
}) {}
