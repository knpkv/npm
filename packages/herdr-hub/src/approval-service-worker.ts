/// <reference lib="webworker" />

import { Effect, Result, Schema } from "effect"
import { blockedPushDeepLink, showBlockedNotification } from "./blocked-push-pwa.js"
import { PushPayload } from "./model.js"
import { approvalDeepLink, handleNotificationClick, showApprovalNotification } from "./pwa.js"

class ServiceWorkerScopeError extends Schema.TaggedError<ServiceWorkerScopeError>()(
  "ServiceWorkerScopeError",
  { cause: Schema.Defect() }
) {}

class WorkerPayloadError extends Schema.TaggedError<WorkerPayloadError>()(
  "WorkerPayloadError",
  { cause: Schema.Defect() }
) {}

class WorkerNotificationError extends Schema.TaggedError<WorkerNotificationError>()(
  "WorkerNotificationError",
  { cause: Schema.Defect() }
) {}

const workerResult = Schema.decodeUnknownResult(
  Schema.instanceOf(ServiceWorkerGlobalScope)
)(self)
if (Result.isFailure(workerResult)) {
  throw new ServiceWorkerScopeError({ cause: workerResult.failure })
}

const worker = workerResult.success

worker.oninstall = (event) => {
  event.waitUntil(worker.skipWaiting())
}

worker.onactivate = (event) => {
  event.waitUntil(worker.clients.claim())
}

worker.onpush = (event) => {
  const effect = Effect.gen(function*() {
    const unknown = yield* Effect.try({
      try: () => event.data?.json(),
      catch: (cause) => new WorkerPayloadError({ cause })
    })
    const payload = yield* Schema.decodeUnknownEffect(PushPayload)(
      unknown
    ).pipe(Effect.mapError((cause) => new WorkerPayloadError({ cause })))
    yield* Effect.tryPromise({
      try: () => {
        const registration = {
          scope: worker.registration.scope,
          showNotification: (title: string, options: NotificationOptions) =>
            worker.registration.showNotification(title, options)
        }
        return "kind" in payload
          ? showBlockedNotification(registration, payload)
          : showApprovalNotification(
            registration,
            (count) =>
              "setAppBadge" in worker.navigator
                ? worker.navigator.setAppBadge(count)
                : Promise.resolve(),
            payload
          )
      },
      catch: (cause) => new WorkerNotificationError({ cause })
    })
  })
  event.waitUntil(Effect.runPromise(effect))
}

worker.onnotificationclick = (event) => {
  event.notification.close()
  const effect = Effect.gen(function*() {
    const unknown: unknown = event.notification.data
    const payload = yield* Schema.decodeUnknownEffect(PushPayload)(unknown).pipe(
      Effect.mapError((cause) => new WorkerPayloadError({ cause }))
    )
    const canonicalUrl = new URL("/", worker.registration.scope).href
    const deepLinkUrl = "kind" in payload
      ? blockedPushDeepLink(canonicalUrl, payload)
      : approvalDeepLink(canonicalUrl, payload)
    yield* Effect.tryPromise({
      try: () =>
        handleNotificationClick(
          {
            matchAll: (options) =>
              worker.clients
                .matchAll(options)
                .then((clients) =>
                  clients.map((client) => ({
                    focus: () => client.focus().then(() => undefined),
                    navigate: (url) =>
                      client.navigate(url).then((navigated) =>
                        navigated === null ? null : {
                          focus: () => navigated.focus().then(() => undefined)
                        }
                      ),
                    url: client.url
                  }))
                ),
            openWindow: (url) => worker.clients.openWindow(url).then(() => undefined)
          },
          deepLinkUrl
        ),
      catch: (cause) => new WorkerNotificationError({ cause })
    })
  })
  event.waitUntil(Effect.runPromise(effect))
}
