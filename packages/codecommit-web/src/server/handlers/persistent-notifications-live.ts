import { HttpApiBuilder } from "@effect/platform"
import { PRService } from "@knpkv/codecommit-core"
import { Effect } from "effect"
import { CodeCommitApi } from "../Api.js"

export const PersistentNotificationsLive = HttpApiBuilder.group(
  CodeCommitApi,
  "persistentNotifications",
  (handlers) =>
    Effect.gen(function*() {
      const prService = yield* PRService.PRService

      return handlers
        .handle("list", ({ urlParams }) =>
          prService.getPersistentNotifications({
            limit: urlParams.limit ?? 20,
            ...(urlParams.cursor !== undefined ? { cursor: urlParams.cursor } : {})
          }))
        .handle("count", () =>
          prService.getUnreadNotificationCount().pipe(
            Effect.map((unread) => ({ unread }))
          ))
        .handle("markRead", ({ payload }) =>
          prService.markNotificationRead(payload.id).pipe(
            Effect.map(() => "ok")
          ))
        .handle("markAllRead", () =>
          prService.markAllNotificationsRead().pipe(
            Effect.map(() => "ok")
          ))
    })
)
