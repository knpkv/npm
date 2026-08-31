import { Effect, Ref } from "effect"
import { PushEndpointNotAllowedError, PushSubscriptionCleanupError } from "./errors.js"

export const validatePushEndpoint = (
  endpoint: string,
  allowedOrigins: ReadonlyArray<string>
) =>
  Effect.try({
    try: () => new URL(endpoint).origin,
    catch: () => new PushEndpointNotAllowedError({ origin: "invalid" })
  }).pipe(
    Effect.flatMap((origin) =>
      Effect.forEach(
        allowedOrigins,
        (allowedOrigin) =>
          Effect.try({
            try: () => new URL(allowedOrigin).origin,
            catch: () => new PushEndpointNotAllowedError({ origin: allowedOrigin })
          })
      ).pipe(
        Effect.flatMap((canonicalOrigins) =>
          canonicalOrigins.includes(origin)
            ? Effect.succeed(endpoint)
            : Effect.fail(new PushEndpointNotAllowedError({ origin }))
        )
      )
    )
  )

export interface OwnedPushSubscription {
  readonly unsubscribe: () => Promise<boolean>
}

export interface CurrentPushSubscription extends OwnedPushSubscription {
  readonly options: {
    readonly applicationServerKey: ArrayBuffer | null
  }
}

const applicationServerKeysEqual = (
  current: ArrayBuffer | null,
  expected: ArrayBuffer
): boolean => {
  if (current === null || current.byteLength !== expected.byteLength) return false
  const currentBytes = new Uint8Array(current)
  const expectedBytes = new Uint8Array(expected)
  return currentBytes.every((byte, index) => byte === expectedBytes[index])
}

export const reconcileExistingPushSubscription = <
  Subscription,
  CheckError,
  CheckRequirements,
  RegisterResult,
  RegisterError,
  RegisterRequirements
>(
  subscription: Subscription | null,
  isRegistered: (
    subscription: Subscription
  ) => Effect.Effect<boolean, CheckError, CheckRequirements>,
  register: (
    subscription: Subscription
  ) => Effect.Effect<RegisterResult, RegisterError, RegisterRequirements>
) =>
  subscription === null
    ? Effect.succeed(false)
    : isRegistered(subscription).pipe(
      Effect.flatMap((registered) =>
        registered
          ? Effect.succeed(true)
          : register(subscription).pipe(Effect.as(true))
      )
    )

export const reconcilePushSubscriptionState = <
  Subscription,
  CheckError,
  CheckRequirements,
  RegisterResult,
  RegisterError,
  RegisterRequirements
>(
  permission: "default" | "denied" | "granted",
  subscription: Subscription | null,
  isRegistered: (
    subscription: Subscription
  ) => Effect.Effect<boolean, CheckError, CheckRequirements>,
  register: (
    subscription: Subscription
  ) => Effect.Effect<RegisterResult, RegisterError, RegisterRequirements>
) =>
  permission === "denied"
    ? Effect.succeed<"denied">("denied")
    : reconcileExistingPushSubscription(
      subscription,
      isRegistered,
      register
    ).pipe(
      Effect.map(
        (registered): "disabled" | "enabled" => registered ? "enabled" : "disabled"
      )
    )

export const registerNewPushSubscription = Effect.fn("PushSubscription.registerNew")(function*<
  Subscription extends OwnedPushSubscription,
  A,
  AcquireError,
  AcquireRequirements,
  RegisterError,
  RegisterRequirements
>(
  acquire: Effect.Effect<Subscription, AcquireError, AcquireRequirements>,
  register: (
    subscription: Subscription
  ) => Effect.Effect<A, RegisterError, RegisterRequirements>
) {
  const retained = yield* Ref.make(false)
  return yield* Effect.acquireUseRelease(
    acquire,
    (subscription) =>
      register(subscription).pipe(
        Effect.tap(() => Ref.set(retained, true))
      ),
    (subscription) =>
      Ref.get(retained).pipe(
        Effect.flatMap((keep) =>
          keep
            ? Effect.void
            : Effect.tryPromise({
              try: () => subscription.unsubscribe(),
              catch: (cause) => new PushSubscriptionCleanupError({ cause })
            }).pipe(Effect.asVoid)
        )
      )
  )
})

export const reconcileCurrentPushSubscription = Effect.fn(
  "PushSubscription.reconcileCurrent"
)(function*<
  Subscription extends CurrentPushSubscription,
  CheckError,
  CheckRequirements,
  RegisterResult,
  RegisterError,
  RegisterRequirements,
  AcquireError,
  AcquireRequirements
>(
  subscription: Subscription,
  expectedApplicationServerKey: ArrayBuffer,
  acquire: Effect.Effect<Subscription, AcquireError, AcquireRequirements>,
  isRegistered: (
    subscription: Subscription
  ) => Effect.Effect<boolean, CheckError, CheckRequirements>,
  register: (
    subscription: Subscription
  ) => Effect.Effect<RegisterResult, RegisterError, RegisterRequirements>
) {
  if (
    applicationServerKeysEqual(
      subscription.options.applicationServerKey,
      expectedApplicationServerKey
    )
  ) {
    return yield* reconcileExistingPushSubscription(
      subscription,
      isRegistered,
      register
    )
  }
  const unsubscribed = yield* Effect.tryPromise({
    try: () => subscription.unsubscribe(),
    catch: (cause) => new PushSubscriptionCleanupError({ cause })
  })
  if (!unsubscribed) {
    return yield* new PushSubscriptionCleanupError({
      cause: "browser push subscription remained active after key rotation"
    })
  }
  yield* registerNewPushSubscription(acquire, register)
  return true
})

export const unregisterPushSubscription = Effect.fn("PushSubscription.unregister")(function*<
  UnsubscribeError,
  UnsubscribeRequirements,
  RemoveResult,
  RemoveError,
  RemoveRequirements
>(
  unsubscribe: Effect.Effect<
    boolean,
    UnsubscribeError,
    UnsubscribeRequirements
  >,
  removeServerRegistration: Effect.Effect<
    RemoveResult,
    RemoveError,
    RemoveRequirements
  >
): Effect.fn.Return<
  RemoveResult,
  UnsubscribeError | RemoveError | PushSubscriptionCleanupError,
  UnsubscribeRequirements | RemoveRequirements
> {
  const unsubscribed = yield* unsubscribe
  if (!unsubscribed) {
    return yield* new PushSubscriptionCleanupError({
      cause: "browser push subscription remained active"
    })
  }
  return yield* removeServerRegistration
})
