import { HttpApiBuilder, HttpServerResponse } from "@effect/platform"
import { CacheService, PRService } from "@knpkv/codecommit-core"
import { AppStatus, PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { Duration, Effect, Ref, Schedule, Schema, Stream, SubscriptionRef } from "effect"
import { CodeCommitApi, NotificationResponse } from "../Api.js"

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
  unreadNotificationCount: Schema.Number,
  notifications: Schema.Struct({
    items: Schema.Array(NotificationResponse),
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
    const prRepo = yield* CacheService.PullRequestRepo
    const notificationRepo = yield* CacheService.NotificationRepo
    const hub = yield* CacheService.EventsHub

    // Cache unread count + notifications — re-query on relevant triggers
    const initialCount = yield* notificationRepo.unreadCount().pipe(Effect.catchAll(() => Effect.succeed(0)))
    const lastUnreadRef = yield* Ref.make(initialCount)
    const initialNotifications = yield* notificationRepo.findAll({ limit: 20 }).pipe(
      Effect.catchAll(() => Effect.succeed({ items: [] as ReadonlyArray<typeof NotificationResponse.Type> }))
    )
    const lastNotificationsRef = yield* Ref.make(initialNotifications)

    // Build full SSE payload — reused for initial event + change events
    const buildPayload = () =>
      Effect.gen(function*() {
        const prState = yield* SubscriptionRef.get(prService.state)
        const pullRequests = yield* prRepo.findAll().pipe(
          Effect.map((rows) => rows.map((row) => PRService.decodeCachedPR(row))),
          Effect.catchAllCause(() => SubscriptionRef.get(prService.state).pipe(Effect.map((s) => s.pullRequests)))
        )
        const unreadCount = yield* notificationRepo.unreadCount().pipe(
          Effect.tap((c) => Ref.set(lastUnreadRef, c)),
          Effect.catchAllCause(() => Ref.get(lastUnreadRef))
        )
        const notifications = yield* notificationRepo.findAll({ limit: 20 }).pipe(
          Effect.tap((p) => Ref.set(lastNotificationsRef, p)),
          Effect.catchAllCause(() => Ref.get(lastNotificationsRef))
        )

        const payload = yield* encode({
          accounts: prState.accounts,
          status: prState.status,
          pullRequests,
          statusDetail: prState.statusDetail,
          error: prState.error,
          lastUpdated: prState.lastUpdated,
          currentUser: prState.currentUser,
          unreadNotificationCount: unreadCount,
          notifications
        })

        return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
      }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logWarning("SSE payload failed", cause).pipe(
            Effect.map(() => encoder.encode(":\n\n"))
          )
        )
      )

    return handlers.handleRaw("stream", () =>
      Effect.gen(function*() {
        // Eagerly build initial snapshot before stream starts
        const initialChunk = yield* buildPayload()

        // Watch SubscriptionRef changes directly (no bridge daemon)
        const stateChanges = prService.state.changes
        // Repo changes via hub (PR upserts, notification adds, etc.)
        const repoChanges = hub.subscribe

        const changes = Stream.merge(stateChanges, repoChanges).pipe(
          Stream.debounce(Duration.millis(200)),
          Stream.mapEffect(() => buildPayload())
        )

        // merge (not concat) so subscriptions start immediately — no missed events
        return HttpServerResponse.stream(
          Stream.merge(
            Stream.concat(Stream.make(initialChunk), changes),
            keepalive
          ),
          {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              "connection": "keep-alive"
            }
          }
        )
      }))
  }))
