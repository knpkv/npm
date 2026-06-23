/**
 * SSE event stream handler — pushes full app state to the browser.
 *
 * Streams a serialized SsePayload (pull requests, accounts, notifications,
 * sandboxes, pending review count, permission prompts) on every state or
 * repo change. Computes `pendingReviewCount` via {@link needsMyReview}.
 *
 * **Mental model**
 *
 * - Uses handleRaw (not handle) to bypass schema response encoding
 * - Merges stateChanges (SubscriptionRef) + repoChanges (EventsHub), debounced 200ms
 * - 30s keepalive heartbeat prevents browser/proxy timeout
 *
 * @module
 */
import { CacheService, PRService } from "@knpkv/codecommit-core"
import { AppStatus, needsMyReview, PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { PermissionGateLiveTag } from "@knpkv/codecommit-core/PermissionService/PermissionGateLive.js"
import { Duration, Effect, Ref, Schedule, Schema, Stream, SubscriptionRef } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CodeCommitApi, NotificationResponse, SandboxResponse } from "../Api.js"
import { encodeSandbox } from "./sandbox-live.js"

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
  lastUpdated: Schema.optional(Schema.Date),
  currentUser: Schema.optional(Schema.String),
  unreadNotificationCount: Schema.Number,
  notifications: Schema.Struct({
    items: Schema.Array(NotificationResponse),
    nextCursor: Schema.optional(Schema.Number)
  }),
  pendingReviewCount: Schema.Number.pipe(Schema.withDecodingDefaultType(Effect.succeed(0))),
  sandboxes: Schema.Array(SandboxResponse),
  permissionPrompt: Schema.optional(Schema.Struct({
    id: Schema.String,
    operation: Schema.String,
    category: Schema.String,
    context: Schema.String
  }))
})

const encode = Schema.encodeEffect(SsePayload)

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
    const sandboxRepo = yield* CacheService.SandboxRepo
    const hub = yield* CacheService.EventsHub
    const permGate = yield* PermissionGateLiveTag

    // Cache unread count + notifications — re-query on relevant triggers
    const initialCount = yield* notificationRepo.unreadCount().pipe(Effect.catchIf(() => true, () => Effect.succeed(0)))
    const lastUnreadRef = yield* Ref.make(initialCount)
    const initialNotifications = yield* notificationRepo.findAll({ limit: 20 }).pipe(
      Effect.catchIf(() => true, () => Effect.succeed({ items: [] as ReadonlyArray<typeof NotificationResponse.Type> }))
    )
    const lastNotificationsRef = yield* Ref.make(initialNotifications)

    // Build full SSE payload — reused for initial event + change events
    const buildPayload = (refreshNotifs: boolean) =>
      Effect.gen(function*() {
        const prState = yield* SubscriptionRef.get(prService.state)
        const pullRequests = yield* prRepo.findAll().pipe(
          Effect.map((rows) => rows.map((row) => PRService.decodeCachedPR(row))),
          Effect.catchCause(() => SubscriptionRef.get(prService.state).pipe(Effect.map((s) => s.pullRequests)))
        )
        const unreadCount = refreshNotifs
          ? yield* notificationRepo.unreadCount().pipe(
            Effect.tap((c) => Ref.set(lastUnreadRef, c)),
            Effect.catchCause(() => Ref.get(lastUnreadRef))
          )
          : yield* Ref.get(lastUnreadRef)
        const notifications = refreshNotifs
          ? yield* notificationRepo.findAll({ limit: 20 }).pipe(
            Effect.tap((p) => Ref.set(lastNotificationsRef, p)),
            Effect.catchCause(() => Ref.get(lastNotificationsRef))
          )
          : yield* Ref.get(lastNotificationsRef)

        const sandboxes = yield* sandboxRepo.findAll().pipe(
          Effect.map((rows) => rows.map(encodeSandbox)),
          Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<typeof SandboxResponse.Type>))
        )

        const pendingPrompt = yield* permGate.getFirstPending().pipe(
          Effect.catchIf(() => true, () => Effect.succeed(undefined))
        )

        const pendingReviewCount = prState.currentUser
          ? pullRequests.filter((pr) => needsMyReview(pr, prState.currentUser)).length
          : 0

        const payload = yield* encode({
          accounts: prState.accounts,
          status: prState.status,
          pullRequests,
          statusDetail: prState.statusDetail,
          error: prState.error,
          lastUpdated: prState.lastUpdated,
          currentUser: prState.currentUser,
          pendingReviewCount,
          unreadNotificationCount: unreadCount,
          notifications,
          sandboxes,
          permissionPrompt: pendingPrompt
        })

        return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("SSE payload failed", cause).pipe(
            Effect.map(() => encoder.encode(":\n\n"))
          )
        )
      )

    return handlers.handleRaw("stream", () =>
      Effect.gen(function*() {
        // Eagerly build initial snapshot before stream starts
        const initialChunk = yield* buildPayload(true)

        // Watch SubscriptionRef changes directly (no bridge daemon)
        const stateChanges = SubscriptionRef.changes(prService.state).pipe(
          Stream.map((): boolean => false)
        )
        // Repo changes via hub (PR upserts, notification adds, etc.)
        const repoChanges = hub.subscribe.pipe(
          Stream.map((): boolean => true)
        )

        const changes = Stream.merge(stateChanges, repoChanges).pipe(
          Stream.debounce(Duration.millis(200)),
          Stream.mapEffect((refreshNotifs) => buildPayload(refreshNotifs))
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
