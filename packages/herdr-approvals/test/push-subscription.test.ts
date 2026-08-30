import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { PushSubscriptionRecord } from "../src/model.js"
import {
  reconcileExistingPushSubscription,
  reconcilePushSubscriptionState,
  registerNewPushSubscription,
  unregisterPushSubscription,
  validatePushEndpoint
} from "../src/push-subscription.js"

class RegistrationError extends Schema.TaggedError<RegistrationError>()(
  "RegistrationError",
  { detail: Schema.String }
) {}

describe("browser push subscription ownership", () => {
  it.effect("accepts only configured public push-service origins", () =>
    Effect.gen(function*() {
      for (
        const endpoint of [
          "https://127.0.0.1/push",
          "https://[::1]/push",
          "https://user:password@push.example.test/push"
        ]
      ) {
        expect(
          Result.isFailure(
            Schema.decodeUnknownResult(PushSubscriptionRecord)({
              endpoint,
              expirationTime: null,
              keys: { auth: "auth_key", p256dh: "p256dh_key" }
            })
          )
        ).toBe(true)
      }

      expect(
        yield* validatePushEndpoint(
          "https://fcm.googleapis.com/fcm/send/subscription",
          [
            "https://fcm.googleapis.com",
            "https://updates.push.services.mozilla.com"
          ]
        )
      ).toBe("https://fcm.googleapis.com/fcm/send/subscription")
      expect(
        yield* validatePushEndpoint(
          "https://push.example.test/subscription",
          ["https://Push.Example.Test:443"]
        )
      ).toBe("https://push.example.test/subscription")
      expect(
        yield* validatePushEndpoint(
          "https://push.example.test:8443/subscription",
          ["https://Push.Example.Test:8443"]
        )
      ).toBe("https://push.example.test:8443/subscription")
      const rejected = yield* Effect.result(
        validatePushEndpoint(
          "https://push.example.test/subscription",
          ["https://fcm.googleapis.com"]
        )
      )
      expect(rejected).toMatchObject({
        failure: {
          _tag: "PushEndpointNotAllowedError",
          origin: "https://push.example.test"
        }
      })
      expect(
        yield* Effect.result(
          validatePushEndpoint(
            "https://push.example.test/subscription",
            ["https://push.example.test:99999"]
          )
        )
      ).toMatchObject({
        failure: {
          _tag: "PushEndpointNotAllowedError",
          origin: "https://push.example.test:99999"
        }
      })
    }))

  it.effect("re-registers an existing browser subscription with the server", () => {
    let registrations = 0
    return Effect.gen(function*() {
      expect(
        yield* reconcileExistingPushSubscription(
          { endpoint: "https://push.example/subscription" },
          () => Effect.succeed(false),
          () =>
            Effect.sync(() => {
              registrations += 1
            })
        )
      ).toBe(true)
      expect(registrations).toBe(1)
      expect(
        yield* reconcileExistingPushSubscription(
          { endpoint: "https://push.example/subscription" },
          () => Effect.succeed(true),
          () => Effect.die("registered server subscription must be retained")
        )
      ).toBe(true)
      expect(
        yield* reconcileExistingPushSubscription(
          null,
          () => Effect.die("missing browser subscription must not be checked"),
          () => Effect.die("missing browser subscription must not register")
        )
      ).toBe(false)
      expect(registrations).toBe(1)
    })
  })

  it.effect("does not register a browser subscription after permission denial", () =>
    Effect.gen(function*() {
      expect(
        yield* reconcilePushSubscriptionState(
          "denied",
          { endpoint: "https://push.example/subscription" },
          () => Effect.die("denied permission must not check the server"),
          () => Effect.die("denied permission must not register")
        )
      ).toBe("denied")
    }))

  it.effect("unsubscribes a new subscription when server registration fails", () => {
    let unsubscribed = 0
    return Effect.gen(function*() {
      const result = yield* Effect.result(
        registerNewPushSubscription(
          Effect.succeed({
            unsubscribe: () => {
              unsubscribed += 1
              return Promise.resolve(true)
            }
          }),
          () => Effect.fail(new RegistrationError({ detail: "server rejected subscription" }))
        )
      )
      expect(Result.isFailure(result)).toBe(true)
      expect(unsubscribed).toBe(1)
    })
  })

  it.effect("retains a new subscription after server registration succeeds", () => {
    let unsubscribed = 0
    return Effect.gen(function*() {
      yield* registerNewPushSubscription(
        Effect.succeed({
          unsubscribe: () => {
            unsubscribed += 1
            return Promise.resolve(true)
          }
        }),
        () => Effect.void
      )
      expect(unsubscribed).toBe(0)
    })
  })

  it.effect("keeps the server registration when browser unsubscribe fails", () => {
    let removals = 0
    return Effect.gen(function*() {
      const rejected = yield* Effect.result(
        unregisterPushSubscription(
          Effect.fail(new RegistrationError({ detail: "browser rejected" })),
          Effect.sync(() => {
            removals += 1
          })
        )
      )
      expect(Result.isFailure(rejected)).toBe(true)
      expect(removals).toBe(0)

      const retained = yield* Effect.result(
        unregisterPushSubscription(
          Effect.succeed(false),
          Effect.sync(() => {
            removals += 1
          })
        )
      )
      expect(Result.isFailure(retained)).toBe(true)
      expect(removals).toBe(0)
    })
  })

  it.effect("removes the server registration after browser unsubscribe succeeds", () => {
    let removals = 0
    return Effect.gen(function*() {
      yield* unregisterPushSubscription(
        Effect.succeed(true),
        Effect.sync(() => {
          removals += 1
        })
      )
      expect(removals).toBe(1)
    })
  })
})
