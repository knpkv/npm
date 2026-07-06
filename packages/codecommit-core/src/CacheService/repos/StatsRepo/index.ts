/**
 * @module StatsRepo
 *
 * Read-only SQL projection layer for the statistics dashboard.
 * Assembles query methods from `./queries` and `./reviewerData` into
 * a single Context.Service.
 *
 * @category CacheService
 */
import { Context, Effect, Layer } from "effect"
import type { Success } from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { DatabaseLive } from "../../Database.js"
import * as Q from "./queries.js"
import { reviewerData } from "./reviewerData.js"

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const makeStatsRepo = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  const service = {
    weeklyVolume: Q.weeklyVolume(sql),
    topContributors: Q.topContributors(sql),
    mostActivePRs: Q.mostActivePRs(sql),
    prSizeDistribution: Q.prSizeDistribution(sql),
    avgDiffSize: Q.avgDiffSize(sql),
    diffSizeByContributor: Q.diffSizeByContributor(sql),
    stalePRs: Q.stalePRs(sql),
    healthIndicators: Q.healthIndicators(sql),
    filterOptions: Q.filterOptions(sql),
    totalComments: Q.totalComments(sql),
    reviewerData: reviewerData(sql),
    mergeTimeDetails: Q.mergeTimeDetails(sql),
    avgTimeToMerge: Q.avgTimeToMerge(sql),
    dataAvailableSince: Q.dataAvailableSince(sql)
  }
  return service
})

export interface StatsRepoShape extends Success<typeof makeStatsRepo> {}

export class StatsRepo extends Context.Service<
  StatsRepo,
  StatsRepoShape
>()("StatsRepo") {
  static readonly Default = Layer.effect(StatsRepo, makeStatsRepo).pipe(
    Layer.provide(DatabaseLive)
  )
}

export declare namespace StatsRepo {
  /**
   * @category models
   */
  export interface Filters {
    readonly repo?: string | undefined
    readonly author?: string | undefined
    readonly account?: string | undefined
  }
}
