import * as SqlClient from "@effect/sql/SqlClient"
import { Effect } from "effect"
import { DatabaseLive } from "../Database.js"

interface SubscriptionRow {
  readonly aws_account_id: string
  readonly pull_request_id: string
}

export class SubscriptionRepo extends Effect.Service<SubscriptionRepo>()("SubscriptionRepo", {
  dependencies: [DatabaseLive],
  effect: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    return {
      subscribe: (awsAccountId: string, prId: string) =>
        sql`INSERT OR IGNORE INTO pr_subscriptions (aws_account_id, pull_request_id)
            VALUES (${awsAccountId}, ${prId})
        `.pipe(Effect.asVoid, Effect.orDie),

      unsubscribe: (awsAccountId: string, prId: string) =>
        sql`DELETE FROM pr_subscriptions
            WHERE aws_account_id = ${awsAccountId} AND pull_request_id = ${prId}
        `.pipe(Effect.asVoid, Effect.orDie),

      findAll: () =>
        sql<SubscriptionRow>`
          SELECT aws_account_id, pull_request_id FROM pr_subscriptions
        `.pipe(
          Effect.map((rows) => rows.map((r) => ({ awsAccountId: r.aws_account_id, pullRequestId: r.pull_request_id }))),
          Effect.orDie
        ),

      isSubscribed: (awsAccountId: string, prId: string) =>
        sql`SELECT 1 FROM pr_subscriptions
            WHERE aws_account_id = ${awsAccountId} AND pull_request_id = ${prId}
        `.pipe(Effect.map((rows) => rows.length > 0), Effect.orDie)
    } as const
  })
}) {}
