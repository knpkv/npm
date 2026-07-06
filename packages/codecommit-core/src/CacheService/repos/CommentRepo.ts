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

const cacheError = (op: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) => new CacheError({ operation: `CommentRepo.${op}`, cause })),
    Effect.withSpan(`CommentRepo.${op}`)
  )

const makeCommentRepo = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const hub = yield* EventsHub

  const find_ = SqlSchema.findOneOption({
    Result: CommentRow,
    Request: Schema.Struct({ awsAccountId: Schema.String, pullRequestId: Schema.String }),
    execute: (req) =>
      sql`SELECT locations_json FROM pr_comments
            WHERE aws_account_id = ${req.awsAccountId}
              AND pull_request_id = ${req.pullRequestId}`
  })

  const upsert_ = (awsAccountId: string, prId: string, locationsJson: string) =>
    sql`INSERT OR REPLACE INTO pr_comments
          (aws_account_id, pull_request_id, locations_json, fetched_at)
          VALUES (${awsAccountId}, ${prId}, ${locationsJson}, datetime('now'))
      `.pipe(Effect.asVoid)

  const publish = hub.publish(RepoChange.Comments())

  const repo = {
    find: (awsAccountId: string, prId: string) =>
      find_({ awsAccountId, pullRequestId: prId }).pipe(
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
    upsert: (awsAccountId: string, prId: string, locationsJson: string) =>
      upsert_(awsAccountId, prId, locationsJson).pipe(Effect.tap(() => publish), cacheError("upsert"))
  }

  return repo
})

export interface CommentRepoShape extends Success<typeof makeCommentRepo> {}

export class CommentRepo extends Context.Service<
  CommentRepo,
  CommentRepoShape
>()("CommentRepo") {
  static readonly Default = Layer.effect(CommentRepo, makeCommentRepo).pipe(
    Layer.provide(Layer.mergeAll(DatabaseLive, EventsHub.Default))
  )
}
