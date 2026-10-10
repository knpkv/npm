import { Effect, Result, Schema } from "effect"
import webPush from "web-push"
import { type ApprovalAppStoreError, PushDeliveryError } from "./errors.js"
import type { ApprovalPushPayload, PushSubscriptionRecord, VapidKeyPair } from "./model.js"
import { pushDeliveryTtlSeconds } from "./push-policy.js"
import { validatePushEndpoint } from "./push-subscription.js"
import type { ApprovalAppStore } from "./store.js"

export const generateVapidKeys = (): VapidKeyPair => webPush.generateVAPIDKeys()

const WebPushFailure = Schema.Struct({ statusCode: Schema.Number })

export const makePushSender = (
  keys: VapidKeyPair,
  subject: string,
  store: ApprovalAppStore,
  allowedOrigins: ReadonlyArray<string>
) =>
  Effect.fn("PushSender.send")(function*(
    subscription: PushSubscriptionRecord,
    payload: ApprovalPushPayload
  ) {
    yield* validatePushEndpoint(subscription.endpoint, allowedOrigins)
    yield* Effect.tryPromise({
      try: () =>
        webPush.sendNotification(subscription, JSON.stringify(payload), {
          TTL: pushDeliveryTtlSeconds,
          timeout: 10_000,
          urgency: "high",
          vapidDetails: {
            privateKey: keys.privateKey,
            publicKey: keys.publicKey,
            subject
          }
        }),
      catch: (cause) => {
        const decoded = Schema.decodeUnknownResult(WebPushFailure)(cause)
        return new PushDeliveryError({
          operation: "webpush.send",
          statusCode: Result.isSuccess(decoded) ? decoded.success.statusCode : null,
          cause
        })
      }
    }).pipe(
      Effect.catchTag(
        "PushDeliveryError",
        (
          error
        ): Effect.Effect<void, ApprovalAppStoreError | PushDeliveryError> =>
          error.statusCode === 404 || error.statusCode === 410
            ? store.deleteSubscriptionPrivileged(subscription.endpoint)
            : Effect.fail(error)
      )
    )
  })
