import { HttpApiBuilder, HttpServerResponse } from "@effect/platform"
import { CacheService, NotificationsService, PRService } from "@knpkv/codecommit-core"
import type { RepoChange } from "@knpkv/codecommit-core/CacheService/EventsHub.js"
import { AppStatus, PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { Duration, Effect, Ref, Schedule, Schema, Stream, SubscriptionRef } from "effect"
import { CodeCommitApi, NotificationItemResponse, PersistentNotificationResponse } from "../Api.js"

const AccountState = Schema.Struct({
  profile: Schema.String,
  region: Schema.String,
  enabled: Schema.Boolean
})

const SsePayload = Schema.Struct({
  pullRequests: Schema.Array(PullRequest),
  accounts: Schema.Array(AccountState),
  status: AppStatus,
  statusDetail: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  lastUpdated: Schema.optional(Schema.DateFromSelf),
  currentUser: Schema.optional(Schema.String),
  notifications: Schema.Array(NotificationItemResponse),
  unreadNotificationCount: Schema.Number,
  persistentNotifications: Schema.Struct({
    items: Schema.Array(PersistentNotificationResponse),
    nextCursor: Schema.optional(Schema.Number)
  })
})

const encode = Schema.encode(SsePayload)

const encoder = new TextEncoder()

// SSE keepalive — prevents browser timeout
const keepalive = Stream.schedule(
  Stream.succeed(encoder.encode(":\n\n")),
  Schedule.spaced(Duration.seconds(30))
)

export const EventsLive = HttpApiBuilder.group(CodeCommitApi, "events", (handlers) =>
  Effect.gen(function*() {
    const prService = yield* PRService.PRService
    const notificationsService = yield* NotificationsService.NotificationsService
    const prRepo = yield* CacheService.PullRequestRepo
    const notificationRepo = yield* CacheService.NotificationRepo
    const hub = yield* CacheService.EventsHub

    // Bridge SubscriptionRef changes → hub (runs for server lifetime)
    yield* Effect.forkDaemon(
      prService.state.changes.pipe(
        Stream.runForEach(() => hub.publish({ _tag: "AppState" }))
      )
    )
    yield* Effect.forkDaemon(
      notificationsService.state.changes.pipe(
        Stream.runForEach(() => hub.publish({ _tag: "SystemNotifications" }))
      )
    )

    // Classify change tags into trigger categories
    const classify = (change: RepoChange): "repo" | "state" | "notif" => {
      switch (change._tag) {
        case "AppState": return "state"
        case "SystemNotifications": return "notif"
        default: return "repo"
      }
    }

    // Cache unread count + persistent notifications — re-query on relevant triggers
    const initialCount = yield* prService.getUnreadNotificationCount().pipe(Effect.catchAll(() => Effect.succeed(0)))
    const lastUnreadRef = yield* Ref.make(initialCount)
    const initialPersistent = yield* prService.getPersistentNotifications({ limit: 20 }).pipe(
      Effect.catchAll(() => Effect.succeed({ items: [] as ReadonlyArray<typeof PersistentNotificationResponse.Type> }))
    )
    const lastPersistentRef = yield* Ref.make(initialPersistent)

    const stateStream = hub.subscribe.pipe(
      Stream.map(classify),
      Stream.debounce(Duration.millis(200)),
      Stream.mapEffect((trigger) =>
        Effect.all({
          prState: SubscriptionRef.get(prService.state),
          notifState: SubscriptionRef.get(notificationsService.state),
          // Read PRs from SQLite on repo changes; use SubscriptionRef on state-only changes
          pullRequests: trigger === "repo"
            ? prRepo.findAll().pipe(
              Effect.map((rows) => rows.map((row) => PRService.decodeCachedPR(row))),
              Effect.catchAll(() => SubscriptionRef.get(prService.state).pipe(Effect.map((s) => s.pullRequests)))
            )
            : SubscriptionRef.get(prService.state).pipe(Effect.map((s) => s.pullRequests)),
          unreadCount: trigger === "repo" || trigger === "notif"
            ? notificationRepo.unreadCount().pipe(
              Effect.tap((c) => Ref.set(lastUnreadRef, c)),
              Effect.catchAll(() => Ref.get(lastUnreadRef))
            )
            : Ref.get(lastUnreadRef),
          persistentNotifications: trigger === "repo" || trigger === "notif"
            ? notificationRepo.findAll({ limit: 20 }).pipe(
              Effect.tap((p) => Ref.set(lastPersistentRef, p)),
              Effect.catchAll(() => Ref.get(lastPersistentRef))
            )
            : Ref.get(lastPersistentRef)
        })
      ),
      Stream.mapEffect(({ notifState, persistentNotifications, prState, pullRequests, unreadCount }) =>
        encode({
          ...prState,
          pullRequests,
          notifications: notifState.items.map((item) => ({
            type: item.type,
            title: item.title,
            message: item.message,
            timestamp: item.timestamp.toISOString(),
            ...(item.profile ? { profile: item.profile } : {})
          })),
          unreadNotificationCount: unreadCount,
          persistentNotifications
        }).pipe(
          Effect.map((payload) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)),
          Effect.catchAll((e) =>
            Effect.logWarning("SSE encode failed", e).pipe(
              Effect.map(() => encoder.encode(":\n\n"))
            )
          )
        )
      )
    )

    return handlers.handleRaw("stream", () =>
      Effect.succeed(
        HttpServerResponse.stream(
          Stream.merge(stateStream, keepalive),
          {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              "connection": "keep-alive"
            }
          }
        )
      ))
  }))
