import { decodeBoundedResponseJson } from "@knpkv/herdr-fleet/response"
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { NotificationState } from "./approval-app-view.js"
import type { BlockedPushMutation } from "./blocked-push-model.js"
import { BlockedPushSettings, StageHeartbeat } from "./blocked-push-model.js"
import { PushPublicConfiguration, PushSubscriptionStatus } from "./model.js"
import { applicationServerKey, applicationServerKeysEqual } from "./push-subscription.js"

export class BlockedNotificationClientError
  extends Schema.TaggedError<BlockedNotificationClientError>()("BlockedNotificationClientError", {
    operation: Schema.String,
    cause: Schema.Defect()
  })
{}
const failed = (operation: string) => (cause: unknown) => new BlockedNotificationClientError({ operation, cause })

const requestSettings = Effect.fn("BlockedNotificationClient.settings")(function*(mutation?: BlockedPushMutation) {
  const client = yield* HttpClient.HttpClient
  const request = mutation === undefined
    ? HttpClientRequest.get("/v1/push/blocked-settings")
    : yield* HttpClientRequest.patch("/v1/push/blocked-settings").pipe(
      HttpClientRequest.bodyJson(mutation),
      Effect.mapError(failed("settings.encode"))
    )
  const response = yield* client.execute(request).pipe(Effect.mapError(failed("settings.request")))
  if (response.status < 200 || response.status >= 300) {
    return yield* new BlockedNotificationClientError({ operation: "settings.status", cause: response.status })
  }
  return yield* decodeBoundedResponseJson(response, BlockedPushSettings).pipe(
    Effect.mapError(failed("settings.decode"))
  )
})
export const loadBlockedSettings = requestSettings()
export const mutateBlockedSettings = (mutation: BlockedPushMutation) => requestSettings(mutation)

export const reportStageHeartbeat = Effect.fn("BlockedNotificationClient.heartbeat")(function*(input: StageHeartbeat) {
  const body = yield* Schema.decodeUnknownEffect(StageHeartbeat)(input).pipe(
    Effect.mapError(failed("heartbeat.encode"))
  )
  const client = yield* HttpClient.HttpClient
  const request = yield* HttpClientRequest.post("/v1/push/stage-heartbeat").pipe(
    HttpClientRequest.bodyJson(body),
    Effect.mapError(failed("heartbeat.encode"))
  )
  const response = yield* client.execute(request).pipe(Effect.mapError(failed("heartbeat.request")))
  if (response.status < 200 || response.status >= 300) {
    return yield* new BlockedNotificationClientError({ operation: "heartbeat.status", cause: response.status })
  }
})

/** Inspect this device without enrolling it; Approvals owns subscription changes. */
export const loadBlockedDevicePushState = Effect.gen(function*() {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.get("/v1/push/config").pipe(Effect.mapError(failed("device.config.request")))
  if (response.status < 200 || response.status >= 300) {
    return yield* new BlockedNotificationClientError({ operation: "device.config.status", cause: response.status })
  }
  const config = yield* decodeBoundedResponseJson(response, PushPublicConfiguration).pipe(
    Effect.mapError(failed("device.config.decode"))
  )
  if (!config.enabled || config.publicKey === null) return "disabled"
  if (
    !window.isSecureContext || !("Notification" in window) || !("PushManager" in window) ||
    !("serviceWorker" in navigator)
  ) return "unsupported"
  if (Notification.permission !== "granted") return Notification.permission === "denied" ? "denied" : "disabled"
  const registration = yield* Effect.tryPromise({
    try: () => navigator.serviceWorker.getRegistration("/"),
    catch: failed("device.registration")
  })
  if (registration === undefined) return "disabled"
  const subscription = yield* Effect.tryPromise({
    try: () => registration.pushManager.getSubscription(),
    catch: failed("device.subscription")
  })
  if (subscription === null) return "disabled"
  const publicKey = config.publicKey
  const expectedKey = yield* Effect.try({
    try: () => applicationServerKey(publicKey),
    catch: failed("device.key")
  })
  if (!applicationServerKeysEqual(subscription.options.applicationServerKey, expectedKey)) return "disabled"
  const statusResponse = yield* client.get(
    `/v1/push/subscriptions?endpoint=${encodeURIComponent(subscription.endpoint)}`
  ).pipe(Effect.mapError(failed("device.status.request")))
  if (statusResponse.status < 200 || statusResponse.status >= 300) {
    return yield* new BlockedNotificationClientError({
      operation: "device.status.status",
      cause: statusResponse.status
    })
  }
  const status = yield* decodeBoundedResponseJson(statusResponse, PushSubscriptionStatus).pipe(
    Effect.mapError(failed("device.status.decode"))
  )
  return status.subscribed ? "enabled" : "disabled"
}).pipe(Effect.map((state): NotificationState => state))
