import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { PushSubscriptionRecord } from "../src/model.js"
import {
  reconcileCurrentPushSubscription,
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
  it.effect("replaces browser subscriptions after application-server key rotation", () => {
    const key = (...bytes: ReadonlyArray<number>): ArrayBuffer => Uint8Array.from(bytes).buffer
    let acquired = 0
    let removed = ""
    let registered = ""
    let retainedUnsubscribed = 0
    let unsubscribed = 0
    const replacement = {
      endpoint: "https://push.example/new",
      options: { applicationServerKey: key(2, 3, 4) },
      unsubscribe: () => Promise.resolve(true)
    }
    const acquire = Effect.sync(() => {
      acquired += 1
      return replacement
    })
    return Effect.gen(function*() {
      expect(
        yield* reconcileCurrentPushSubscription(
          {
            endpoint: "https://push.example/old",
            options: { applicationServerKey: key(1, 2, 3) },
            unsubscribe: () => {
              unsubscribed += 1
              return Promise.resolve(true)
            }
          },
          key(2, 3, 4),
          acquire,
          () => Effect.die("rotated subscription must not be checked"),
          (subscription) =>
            Effect.sync(() => {
              registered = subscription.endpoint
            }),
          (subscription) =>
            Effect.sync(() => {
              removed = subscription.endpoint
            })
        )
      ).toBe(true)
      expect({ acquired, registered, removed, unsubscribed }).toEqual({
        acquired: 1,
        registered: replacement.endpoint,
        removed: "https://push.example/old",
        unsubscribed: 1
      })

      expect(
        yield* reconcileCurrentPushSubscription(
          {
            endpoint: "https://push.example/current",
            options: { applicationServerKey: key(2, 3, 4) },
            unsubscribe: () => {
              retainedUnsubscribed += 1
              return Promise.resolve(true)
            }
          },
          key(2, 3, 4),
          Effect.die("current subscription must not be replaced"),
          () => Effect.succeed(true),
          () => Effect.die("registered current subscription must not be posted again"),
          () => Effect.die("registered current subscription must not be removed")
        )
      ).toBe(true)
      expect(retainedUnsubscribed).toBe(0)

      yield* reconcileCurrentPushSubscription(
        {
          endpoint: "https://push.example/keyless",
          options: { applicationServerKey: null },
          unsubscribe: () => Promise.resolve(true)
        },
        key(2, 3, 4),
        Effect.succeed(replacement),
        () => Effect.die("keyless subscription must not be checked"),
        () => Effect.void,
        () => Effect.void
      )
    })
  })

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
