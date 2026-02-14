import * as SqlClient from "@effect/sql/SqlClient"
import * as SqlSchema from "@effect/sql/SqlSchema"
import { Array as Arr, Effect, Option, Schema } from "effect"
import { PersistentNotificationType } from "../../Domain.js"
import { DatabaseLive } from "../Database.js"
import type { NewNotification } from "../diff.js"
import { EventsHub } from "../EventsHub.js"

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

const DEFAULT_LIMIT = 20

export interface PaginatedNotifications {
  readonly items: ReadonlyArray<NotificationRow>
  readonly nextCursor?: number
}

// We fetch limit+1 rows; if we got more than limit, the extra row proves there's a next page.
// Trim to limit and use the last returned row's id as the cursor for the next request.
const paginate = (rows: ReadonlyArray<NotificationRow>, limit: number): PaginatedNotifications => {
  const [items, overflow] = Arr.splitAt(rows, limit)
  return Arr.isNonEmptyReadonlyArray(overflow)
    ? { items, nextCursor: Option.getOrThrow(Arr.last(items)).id }
    : { items }
}

export class NotificationRepo extends Effect.Service<NotificationRepo>()("NotificationRepo", {
  dependencies: [DatabaseLive, EventsHub.Default],
  effect: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const hub = yield* EventsHub

    const selectCols = sql`
      id, pull_request_id AS "pullRequestId", aws_account_id AS "awsAccountId",
      type, message, created_at AS "createdAt", read
    `

    const findAllUnpaginated = SqlSchema.findAll({
      Result: NotificationRow,
      Request: Schema.Struct({ unreadOnly: Schema.Boolean }),
      execute: (req) =>
        req.unreadOnly
          ? sql`SELECT ${selectCols} FROM notifications WHERE read = 0 ORDER BY id DESC`
          : sql`SELECT ${selectCols} FROM notifications ORDER BY id DESC`
    })

    const add_ = (n: NewNotification) =>
      sql`INSERT INTO notifications (pull_request_id, aws_account_id, type, message)
          VALUES (${n.pullRequestId}, ${n.awsAccountId}, ${n.type}, ${n.message})`.pipe(Effect.asVoid)

    const markRead_ = (id: number) =>
      sql`UPDATE notifications SET read = 1 WHERE id = ${id}`.pipe(Effect.asVoid)

    const markAllRead_ = () =>
      sql`UPDATE notifications SET read = 1 WHERE read = 0`.pipe(Effect.asVoid)

    const publish = hub.publish({ _tag: "Notifications" })

    return {
      findAll: (opts?: {
        readonly unreadOnly?: boolean
        readonly limit?: number
        readonly cursor?: number
      }): Effect.Effect<PaginatedNotifications> => {
        const limit = opts?.limit ?? DEFAULT_LIMIT
        const unreadOnly = opts?.unreadOnly ?? false
        const cursor = opts?.cursor

        if (cursor === undefined) {
          return findAllUnpaginated({ unreadOnly }).pipe(
            Effect.map((rows) => paginate(rows, limit)),
            Effect.orDie
          )
        }

        const fetchLimit = limit + 1
        const base = unreadOnly
          ? sql`SELECT ${selectCols} FROM notifications WHERE read = 0 AND id < ${cursor} ORDER BY id DESC LIMIT ${fetchLimit}`
          : sql`SELECT ${selectCols} FROM notifications WHERE id < ${cursor} ORDER BY id DESC LIMIT ${fetchLimit}`

        return SqlSchema.findAll({ Result: NotificationRow, Request: Schema.Void, execute: () => base })(
          undefined as void
        ).pipe(
          Effect.map((rows) => paginate(rows, limit)),
          Effect.orDie
        )
      },

      add: (n: NewNotification) =>
        add_(n).pipe(Effect.tap(() => publish), Effect.orDie),

      markRead: (id: number) =>
        markRead_(id).pipe(Effect.tap(() => publish), Effect.orDie),

      markAllRead: () =>
        markAllRead_().pipe(Effect.tap(() => publish), Effect.orDie),

      unreadCount: () =>
        sql<{ count: number }>`SELECT count(*) as count FROM notifications WHERE read = 0`.pipe(
          Effect.map((rows) => rows[0]?.count ?? 0),
          Effect.orDie
        )
    } as const
  })
}) {}
