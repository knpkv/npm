import * as SqlClient from "@effect/sql/SqlClient"
import * as SqlSchema from "@effect/sql/SqlSchema"
import { Array as Arr, Effect, Option, Schema } from "effect"
import { CacheError } from "../CacheError.js"
import { DatabaseLive } from "../Database.js"
import type { NewNotification } from "../diff.js"
import { EventsHub, RepoChange } from "../EventsHub.js"

const NotificationRow = Schema.Struct({
  id: Schema.Number,
  pullRequestId: Schema.String,
  awsAccountId: Schema.String,
  type: Schema.String,
  message: Schema.String,
  title: Schema.String,
  profile: Schema.String,
  createdAt: Schema.String,
  read: Schema.Number
})

export type NotificationRow = typeof NotificationRow.Type
export type { NewNotification }

const DEFAULT_LIMIT = 20

type NotifFilter = "system" | "prs" | "all"

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

const cacheError = (op: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) => new CacheError({ operation: `NotificationRepo.${op}`, cause })),
    Effect.withSpan(`NotificationRepo.${op}`, { captureStackTrace: false })
  )

export class NotificationRepo extends Effect.Service<NotificationRepo>()("NotificationRepo", {
  dependencies: [DatabaseLive, EventsHub.Default],
  effect: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const hub = yield* EventsHub

    const findAllUnpaginated = SqlSchema.findAll({
      Result: NotificationRow,
      Request: Schema.Struct({ unreadOnly: Schema.Boolean, filter: Schema.Literal("system", "prs", "all") }),
      execute: (req) => {
        const f = req.filter
        if (req.unreadOnly) {
          if (f === "system") {
            return sql`SELECT * FROM notifications WHERE read = 0 AND pull_request_id = '' ORDER BY id DESC`
          }
          if (f === "prs") {
            return sql`SELECT * FROM notifications WHERE read = 0 AND pull_request_id != '' ORDER BY id DESC`
          }
          return sql`SELECT * FROM notifications WHERE read = 0 ORDER BY id DESC`
        }
        if (f === "system") return sql`SELECT * FROM notifications WHERE pull_request_id = '' ORDER BY id DESC`
        if (f === "prs") return sql`SELECT * FROM notifications WHERE pull_request_id != '' ORDER BY id DESC`
        return sql`SELECT * FROM notifications ORDER BY id DESC`
      }
    })

    const findPaginated_ = SqlSchema.findAll({
      Result: NotificationRow,
      Request: Schema.Struct({
        unreadOnly: Schema.Boolean,
        cursor: Schema.Number,
        limit: Schema.Number,
        filter: Schema.Literal("system", "prs", "all")
      }),
      execute: (req) => {
        const f = req.filter
        if (req.unreadOnly) {
          if (f === "system") {
            return sql`SELECT * FROM notifications WHERE read = 0 AND pull_request_id = '' AND id < ${req.cursor} ORDER BY id DESC LIMIT ${req.limit}`
          }
          if (f === "prs") {
            return sql`SELECT * FROM notifications WHERE read = 0 AND pull_request_id != '' AND id < ${req.cursor} ORDER BY id DESC LIMIT ${req.limit}`
          }
          return sql`SELECT * FROM notifications WHERE read = 0 AND id < ${req.cursor} ORDER BY id DESC LIMIT ${req.limit}`
        }
        if (f === "system") {
          return sql`SELECT * FROM notifications WHERE pull_request_id = '' AND id < ${req.cursor} ORDER BY id DESC LIMIT ${req.limit}`
        }
        if (f === "prs") {
          return sql`SELECT * FROM notifications WHERE pull_request_id != '' AND id < ${req.cursor} ORDER BY id DESC LIMIT ${req.limit}`
        }
        return sql`SELECT * FROM notifications WHERE id < ${req.cursor} ORDER BY id DESC LIMIT ${req.limit}`
      }
    })

    const add_ = (n: NewNotification) =>
      sql`INSERT INTO notifications (pull_request_id, aws_account_id, type, message, title, profile)
          VALUES (${n.pullRequestId}, ${n.awsAccountId}, ${n.type}, ${n.message}, ${n.title ?? ""}, ${n.profile ?? ""})`
        .pipe(Effect.asVoid)

    const markRead_ = (id: number) => sql`UPDATE notifications SET read = 1 WHERE id = ${id}`.pipe(Effect.asVoid)

    const markUnread_ = (id: number) => sql`UPDATE notifications SET read = 0 WHERE id = ${id}`.pipe(Effect.asVoid)

    const markAllRead_ = () => sql`UPDATE notifications SET read = 1 WHERE read = 0`.pipe(Effect.asVoid)

    const publish = hub.publish(RepoChange.Notifications())

    return {
      findAll: (opts?: {
        readonly unreadOnly?: boolean
        readonly limit?: number
        readonly cursor?: number
        readonly filter?: "system" | "prs"
      }): Effect.Effect<PaginatedNotifications, CacheError> => {
        const limit = opts?.limit ?? DEFAULT_LIMIT
        const unreadOnly = opts?.unreadOnly ?? false
        const cursor = opts?.cursor
        const filter: NotifFilter = opts?.filter ?? "all"

        if (cursor === undefined) {
          return findAllUnpaginated({ unreadOnly, filter }).pipe(
            Effect.map((rows) => paginate(rows, limit)),
            cacheError("findAll")
          )
        }

        const fetchLimit = limit + 1
        return findPaginated_({ unreadOnly, cursor, limit: fetchLimit, filter }).pipe(
          Effect.map((rows) => paginate(rows, limit)),
          cacheError("findAll")
        )
      },

      add: (n: NewNotification) => add_(n).pipe(Effect.tap(() => publish), cacheError("add")),

      addSystem: (n: {
        readonly type: string
        readonly title: string
        readonly message: string
        readonly profile?: string
        readonly deduplicate?: boolean
      }) => {
        const insert = add_({
          pullRequestId: "",
          awsAccountId: "",
          type: n.type,
          message: n.message,
          title: n.title,
          profile: n.profile ?? ""
        }).pipe(Effect.tap(() => publish))

        if (!n.deduplicate) {
          return insert.pipe(cacheError("addSystem"))
        }

        // Skip if an unread system notification with same profile+type already exists
        return sql<{ count: number }>`
          SELECT count(*) as count FROM notifications
          WHERE profile = ${n.profile ?? ""} AND type = ${n.type} AND pull_request_id = '' AND read = 0
        `.pipe(
          Effect.flatMap((rows) => (rows[0]?.count ?? 0) > 0 ? Effect.void : insert),
          cacheError("addSystem")
        )
      },

      markRead: (id: number) => markRead_(id).pipe(Effect.tap(() => publish), cacheError("markRead")),

      markUnread: (id: number) => markUnread_(id).pipe(Effect.tap(() => publish), cacheError("markUnread")),

      markAllRead: () => markAllRead_().pipe(Effect.tap(() => publish), cacheError("markAllRead")),

      unreadCount: () =>
        sql<{ count: number }>`SELECT count(*) as count FROM notifications WHERE read = 0`.pipe(
          Effect.map((rows) => rows[0]?.count ?? 0),
          cacheError("unreadCount")
        )
    } as const
  })
}) {}
