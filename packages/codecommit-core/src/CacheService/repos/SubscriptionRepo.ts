import * as SqlClient from "@effect/sql/SqlClient"
import * as SqlSchema from "@effect/sql/SqlSchema"
import { Effect, Schema } from "effect"
import { DatabaseLive } from "../Database.js"
import { EventsHub } from "../EventsHub.js"

const SubscriptionRow = Schema.Struct({
  awsAccountId: Schema.String,
  pullRequestId: Schema.String
})

export class SubscriptionRepo extends Effect.Service<SubscriptionRepo>()("SubscriptionRepo", {
  dependencies: [DatabaseLive, EventsHub.Default],
  effect: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const hub = yield* EventsHub

    const RequestPair = Schema.Struct({ awsAccountId: Schema.String, prId: Schema.String })

    const subscribe_ = SqlSchema.void({
      Request: RequestPair,
      execute: (req) =>
        sql`INSERT OR IGNORE INTO pr_subscriptions (aws_account_id, pull_request_id)
            VALUES (${req.awsAccountId}, ${req.prId})`
    })

    const unsubscribe_ = SqlSchema.void({
      Request: RequestPair,
      execute: (req) =>
        sql`DELETE FROM pr_subscriptions
            WHERE aws_account_id = ${req.awsAccountId} AND pull_request_id = ${req.prId}`
    })

    const findAll_ = SqlSchema.findAll({
      Result: SubscriptionRow,
      Request: Schema.Void,
      execute: () =>
        sql`SELECT aws_account_id AS "awsAccountId", pull_request_id AS "pullRequestId"
            FROM pr_subscriptions`
    })

    const isSubscribed_ = SqlSchema.findOne({
      Result: Schema.Struct({ exists: Schema.Number }),
      Request: RequestPair,
      execute: (req) =>
        sql`SELECT 1 AS "exists" FROM pr_subscriptions
            WHERE aws_account_id = ${req.awsAccountId} AND pull_request_id = ${req.prId}`
    })

    const publish = hub.publish({ _tag: "Subscriptions" })

    return {
      subscribe: (awsAccountId: string, prId: string) =>
        subscribe_({ awsAccountId, prId }).pipe(Effect.tap(() => publish), Effect.orDie),

      unsubscribe: (awsAccountId: string, prId: string) =>
        unsubscribe_({ awsAccountId, prId }).pipe(Effect.tap(() => publish), Effect.orDie),

      findAll: () => findAll_(undefined as void).pipe(Effect.orDie),

      isSubscribed: (awsAccountId: string, prId: string) =>
        isSubscribed_({ awsAccountId, prId }).pipe(Effect.map((o) => o._tag === "Some"), Effect.orDie)
    } as const
  })
}) {}
