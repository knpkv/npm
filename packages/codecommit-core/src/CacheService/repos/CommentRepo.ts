import * as SqlClient from "@effect/sql/SqlClient"
import * as SqlSchema from "@effect/sql/SqlSchema"
import { Effect, Option, Schema } from "effect"
import { DatabaseLive } from "../Database.js"

const CommentRow = Schema.Struct({
  locationsJson: Schema.String
})

export class CommentRepo extends Effect.Service<CommentRepo>()("CommentRepo", {
  dependencies: [DatabaseLive],
  effect: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    const find = SqlSchema.findOne({
      Result: CommentRow,
      Request: Schema.Struct({ awsAccountId: Schema.String, pullRequestId: Schema.String }),
      execute: (req) =>
        sql`
        SELECT locations_json AS "locationsJson" FROM pr_comments
        WHERE aws_account_id = ${req.awsAccountId}
          AND pull_request_id = ${req.pullRequestId}
      `
    })

    return {
      find: (awsAccountId: string, prId: string) =>
        find({ awsAccountId, pullRequestId: prId }).pipe(
          Effect.map(Option.map((r) => {
            try {
              return JSON.parse(r.locationsJson)
            } catch {
              return []
            }
          })),
          Effect.orDie
        ),
      upsert: (awsAccountId: string, prId: string, locationsJson: string) =>
        sql`INSERT OR REPLACE INTO pr_comments
            (aws_account_id, pull_request_id, locations_json, fetched_at)
            VALUES (${awsAccountId}, ${prId}, ${locationsJson}, datetime('now'))
        `.pipe(Effect.asVoid, Effect.orDie)
    } as const
  })
}) {}
