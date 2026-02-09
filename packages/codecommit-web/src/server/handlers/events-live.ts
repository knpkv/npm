import { HttpApiBuilder, HttpServerResponse } from "@effect/platform"
import { NotificationsService, PRService } from "@knpkv/codecommit-core"
import { AppStatus, PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { Duration, Effect, Schedule, Schema, Stream, SubscriptionRef } from "effect"
import { CodeCommitApi, NotificationItemResponse } from "../Api.js"

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
  notifications: Schema.Array(NotificationItemResponse)
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

    // Merge both change streams — emit combined state on either change
    const prChanges = prService.state.changes.pipe(Stream.map(() => "pr" as const))
    const notifChanges = notificationsService.state.changes.pipe(Stream.map(() => "notif" as const))
    const combined = Stream.merge(prChanges, notifChanges)

    const stateStream = combined.pipe(
      Stream.mapEffect(() =>
        Effect.all({
          prState: SubscriptionRef.get(prService.state),
          notifState: SubscriptionRef.get(notificationsService.state)
        })
      ),
      Stream.mapEffect(({ notifState, prState }) =>
        encode({
          ...prState,
          notifications: notifState.items.map((item) => ({
            type: item.type,
            title: item.title,
            message: item.message,
            timestamp: item.timestamp.toISOString(),
            ...(item.profile ? { profile: item.profile } : {})
          }))
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
