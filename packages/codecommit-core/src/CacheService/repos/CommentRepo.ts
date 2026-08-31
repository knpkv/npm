import { Context, Effect, Layer, Option, Schema } from "effect"
import type { Success } from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"
import type { PRCommentLocation } from "../../Domain.js"
import { CacheError } from "../CacheError.js"
import { DatabaseLive } from "../Database.js"
import { EventsHub, RepoChange } from "../EventsHub.js"
import { decodeCommentLocations } from "./commentLocations.js"

const CommentRow = Schema.Struct({
  locationsJson: Schema.String
})

export interface CommentCoordinates {
  readonly repositoryName: string
  readonly accountRegion: string
}

const legacyCoordinate = ""

const cacheError = (op: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) => new CacheError({ operation: `CommentRepo.${op}`, cause })),
    Effect.withSpan(`CommentRepo.${op}`)
  )

const makeCommentRepo = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const hub = yield* EventsHub

  const findLegacy_ = SqlSchema.findOneOption({
    Result: CommentRow,
    Request: Schema.Struct({ awsAccountId: Schema.String, pullRequestId: Schema.String }),
    execute: (req) =>
      sql`SELECT locations_json FROM pr_comments
            WHERE aws_account_id = ${req.awsAccountId}
              AND pull_request_id = ${req.pullRequestId}
              AND repository_name = ${legacyCoordinate}
              AND account_region = ${legacyCoordinate}`
  })

  const findExact_ = SqlSchema.findOneOption({
    Result: CommentRow,
    Request: Schema.Struct({
      awsAccountId: Schema.String,
      pullRequestId: Schema.String,
      repositoryName: Schema.String,
      accountRegion: Schema.String
    }),
    execute: (req) =>
      sql`SELECT locations_json FROM pr_comments
            WHERE aws_account_id = ${req.awsAccountId}
              AND pull_request_id = ${req.pullRequestId}
              AND (
                (repository_name = ${req.repositoryName} AND account_region = ${req.accountRegion})
                OR (
                  repository_name = ${legacyCoordinate}
                  AND account_region = ${legacyCoordinate}
                  AND (
                    SELECT count(*) FROM pull_requests
                    WHERE aws_account_id = ${req.awsAccountId} AND id = ${req.pullRequestId}
                  ) = 1
                )
              )
            ORDER BY CASE
              WHEN repository_name = ${req.repositoryName} AND account_region = ${req.accountRegion} THEN 0
              ELSE 1
            END
            LIMIT 1`
  })

  const upsert_ = (awsAccountId: string, prId: string, locationsJson: string, coordinates?: CommentCoordinates) =>
    sql`INSERT OR REPLACE INTO pr_comments
          (aws_account_id, pull_request_id, repository_name, account_region, locations_json, fetched_at)
          VALUES (${awsAccountId}, ${prId}, ${coordinates?.repositoryName ?? legacyCoordinate}, ${
      coordinates?.accountRegion ?? legacyCoordinate
    },
            ${locationsJson}, datetime('now'))
      `.pipe(Effect.asVoid)

  const publish = hub.publish(RepoChange.Comments())

  const repo = {
    find: (awsAccountId: string, prId: string, coordinates?: CommentCoordinates) =>
      (coordinates === undefined
        ? findLegacy_({ awsAccountId, pullRequestId: prId })
        : findExact_({
          awsAccountId,
          pullRequestId: prId,
          repositoryName: coordinates.repositoryName,
          accountRegion: coordinates.accountRegion
        })).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Option.none<ReadonlyArray<PRCommentLocation>>()),
              onSome: (r) =>
                decodeCommentLocations(r.locationsJson).pipe(
                  Effect.map((decoded) => Option.some(decoded))
                )
            })
          ),
          cacheError("find")
        ),
    upsert: (awsAccountId: string, prId: string, locationsJson: string, coordinates?: CommentCoordinates) =>
      upsert_(awsAccountId, prId, locationsJson, coordinates).pipe(Effect.tap(() => publish), cacheError("upsert"))
  }

  return repo
})

export interface CommentRepoContract extends Success<typeof makeCommentRepo> {}

export class CommentRepo extends Context.Service<
  CommentRepo,
  CommentRepoContract
>()("CommentRepo") {
  static readonly Default = Layer.effect(CommentRepo, makeCommentRepo).pipe(
    Layer.provide(Layer.mergeAll(DatabaseLive, EventsHub.Default))
  )
}
