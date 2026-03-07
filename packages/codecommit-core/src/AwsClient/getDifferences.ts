/**
 * @module getDifferences
 *
 * Mental model: AWS CodeCommit diff stats fetcher. Paginates the getDifferences
 * API to count file-level changes (A/M/D). Returns aggregate
 * {filesAdded, filesModified, filesDeleted}.
 *
 * Uses the shared `withAwsContext` combinator for credentials/retry/timeout.
 *
 * @internal
 */
import type { HttpClient } from "@effect/platform"
import type { Credentials, Region } from "distilled-aws"
import * as codecommit from "distilled-aws/codecommit"
import { Effect } from "effect"
import type { DiffStats, GetDifferencesParams } from "./internal.js"
import { makeApiError, withAwsContext } from "./internal.js"

const paginate = (
  params: GetDifferencesParams,
  acc: DiffStats,
  nextToken?: string
): Effect.Effect<DiffStats, unknown, Credentials.Credentials | HttpClient.HttpClient | Region.Region> =>
  Effect.flatMap(
    codecommit.getDifferences({
      repositoryName: params.repositoryName,
      beforeCommitSpecifier: params.beforeCommitSpecifier,
      afterCommitSpecifier: params.afterCommitSpecifier,
      ...(nextToken ? { NextToken: nextToken } : {})
    }),
    (resp) => {
      const diffs = resp.differences ?? []
      const next: DiffStats = {
        filesAdded: acc.filesAdded + diffs.filter((d) => d.changeType === "A").length,
        filesModified: acc.filesModified + diffs.filter((d) => d.changeType === "M").length,
        filesDeleted: acc.filesDeleted + diffs.filter((d) => d.changeType === "D").length
      }
      return resp.NextToken ? paginate(params, next, resp.NextToken) : Effect.succeed(next)
    }
  )

const callGetDifferences = Effect.fn("callGetDifferences")(
  function*(params: GetDifferencesParams) {
    return yield* paginate(params, { filesAdded: 0, filesModified: 0, filesDeleted: 0 })
  }
)

export const getDifferences = (params: GetDifferencesParams) =>
  withAwsContext(
    "getDifferences",
    params.account,
    callGetDifferences(params).pipe(
      Effect.mapError((cause) => makeApiError("getDifferences", params.account.profile, params.account.region, cause))
    )
  )
