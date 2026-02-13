import * as SqlClient from "@effect/sql/SqlClient"
import * as SqlSchema from "@effect/sql/SqlSchema"
import { Effect, Schema } from "effect"
import { PersistentNotificationType } from "../../Domain.js"
import { DatabaseLive } from "../Database.js"
import type { NewNotification } from "../diff.js"

const NotificationRow = Schema.Struct({
  id: Schema.Number,
  pullRequestId: Schema.String,
  awsAccountId: Schema.String,
  type: PersistentNotificationType,
  message: Schema.String,
  createdAt: Schema.String,
  read: Schema.Number
})

export type NotificationRow = typeof NotificationRow.Type
export type { NewNotification }

export class NotificationRepo extends Effect.Service<NotificationRepo>()("NotificationRepo", {
  dependencies: [DatabaseLive],
  effect: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    const selectCols = sql`
      id, pull_request_id AS "pullRequestId", aws_account_id AS "awsAccountId",
      type, message, created_at AS "createdAt", read
    `

    const findAllQuery = SqlSchema.findAll({
      Result: NotificationRow,
      Request: Schema.Struct({ unreadOnly: Schema.Boolean }),
      execute: (req) =>
        req.unreadOnly
          ? sql`SELECT ${selectCols} FROM notifications WHERE read = 0 ORDER BY created_at DESC`
          : sql`SELECT ${selectCols} FROM notifications ORDER BY created_at DESC`
    })

    return {
      findAll: (opts?: { readonly unreadOnly?: boolean }) =>
        findAllQuery({ unreadOnly: opts?.unreadOnly ?? false }).pipe(Effect.orDie),

      add: (n: NewNotification) =>
        sql`INSERT INTO notifications (pull_request_id, aws_account_id, type, message)
            VALUES (${n.pullRequestId}, ${n.awsAccountId}, ${n.type}, ${n.message})
        `.pipe(Effect.asVoid, Effect.orDie),

      markRead: (id: number) =>
        sql`UPDATE notifications SET read = 1 WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie),

      markAllRead: () => sql`UPDATE notifications SET read = 1 WHERE read = 0`.pipe(Effect.asVoid, Effect.orDie),

      unreadCount: () =>
        sql<{ count: number }>`SELECT count(*) as count FROM notifications WHERE read = 0`.pipe(
          Effect.map((rows) => rows[0]?.count ?? 0),
          Effect.orDie
        )
    } as const
  })
}) {}
