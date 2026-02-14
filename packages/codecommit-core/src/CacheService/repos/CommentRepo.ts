import * as SqlClient from "@effect/sql/SqlClient"
import * as SqlSchema from "@effect/sql/SqlSchema"
import { Effect, Option, Schema } from "effect"
import type { PRCommentLocation } from "../../Domain.js"
import { PRCommentLocationJson } from "../../Domain.js"
import { DatabaseLive } from "../Database.js"
import { EventsHub } from "../EventsHub.js"

const CommentRow = Schema.Struct({
  locationsJson: Schema.String
})

const LocationsFromJson = Schema.parseJson(Schema.Array(PRCommentLocationJson))

export class CommentRepo extends Effect.Service<CommentRepo>()("CommentRepo", {
  dependencies: [DatabaseLive, EventsHub.Default],
  effect: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const hub = yield* EventsHub

    const find_ = SqlSchema.findOne({
      Result: CommentRow,
      Request: Schema.Struct({ awsAccountId: Schema.String, pullRequestId: Schema.String }),
      execute: (req) =>
        sql`
        SELECT locations_json AS "locationsJson" FROM pr_comments
        WHERE aws_account_id = ${req.awsAccountId}
          AND pull_request_id = ${req.pullRequestId}
      `
    })

    const upsert_ = (awsAccountId: string, prId: string, locationsJson: string) =>
      sql`INSERT OR REPLACE INTO pr_comments
          (aws_account_id, pull_request_id, locations_json, fetched_at)
          VALUES (${awsAccountId}, ${prId}, ${locationsJson}, datetime('now'))
      `.pipe(Effect.asVoid)

    const publish = hub.publish({ _tag: "Comments" })

    return {
      find: (awsAccountId: string, prId: string) =>
        find_({ awsAccountId, pullRequestId: prId }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Option.none<ReadonlyArray<PRCommentLocation>>()),
              onSome: (r) =>
                Schema.decodeUnknown(LocationsFromJson)(r.locationsJson).pipe(
                  // PRCommentLocationJson is structurally compatible with PRCommentLocation for diff/count
                  Effect.map((decoded) => Option.some(decoded as unknown as ReadonlyArray<PRCommentLocation>)),
                  Effect.catchAll(() => Effect.succeed(Option.some<ReadonlyArray<PRCommentLocation>>([])))
                )
            })
          ),
          Effect.orDie
        ),
      upsert: (awsAccountId: string, prId: string, locationsJson: string) =>
        upsert_(awsAccountId, prId, locationsJson).pipe(Effect.tap(() => publish), Effect.orDie)
    } as const
  })
}) {}
