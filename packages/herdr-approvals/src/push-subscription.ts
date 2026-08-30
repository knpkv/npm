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
      allowedOrigins.includes(origin)
        ? Effect.succeed(endpoint)
        : Effect.fail(new PushEndpointNotAllowedError({ origin }))
    )
  )

export interface OwnedPushSubscription {
  readonly unsubscribe: () => Promise<boolean>
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
  E,
  R
>(
  acquire: Effect.Effect<Subscription, E, R>,
  register: (subscription: Subscription) => Effect.Effect<A, E, R>
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
