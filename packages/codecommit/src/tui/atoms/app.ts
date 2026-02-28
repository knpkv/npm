import { CacheService, type Domain, PRService } from "@knpkv/codecommit-core"
import type { PaginatedNotifications } from "@knpkv/codecommit-core/CacheService.js"
import { Effect, Fiber, Stream, SubscriptionRef } from "effect"
import { runtimeAtom } from "./runtime.js"

// Track active refresh fiber for cleanup
let activeRefreshFiber: Fiber.RuntimeFiber<void, unknown> | null = null

/**
 * Subscribes to PRService.state changes
 * @category atoms
 */
export const appStateAtom = runtimeAtom.subscribable(
  Effect.gen(function*() {
    const prService = yield* PRService.PRService
    return prService.state
  })
)

/**
 * Triggers a refresh of pull requests
 * @category atoms
 */
export const refreshAtom = runtimeAtom.fn(
  Effect.fnUntraced(function*() {
    // Interrupt previous refresh if still running
    if (activeRefreshFiber) {
      yield* Fiber.interrupt(activeRefreshFiber)
      activeRefreshFiber = null
    }
    const prService = yield* PRService.PRService
    // Use forkDaemon so it survives parent scope, but track for cleanup
    activeRefreshFiber = yield* Effect.forkDaemon(prService.refresh)
  })
)

/**
 * Cleanup function to abort pending requests on exit
 */
export const cleanup = Effect.gen(function*() {
  if (activeRefreshFiber) {
    yield* Fiber.interrupt(activeRefreshFiber)
    activeRefreshFiber = null
  }
})

/**
 * Toggles account enabled state in settings
 * @category atoms
 */
export const toggleAccountAtom = runtimeAtom.fn(
  Effect.fnUntraced(function*(profile: Domain.AwsProfileName) {
    const prService = yield* PRService.PRService
    yield* Effect.forkDaemon(prService.toggleAccount(profile))
  })
)

/**
 * Sets all accounts to enabled or disabled
 * @category atoms
 */
export const setAllAccountsAtom = runtimeAtom.fn(
  Effect.fnUntraced(function*(params: { enabled: boolean; profiles?: Array<Domain.AwsProfileName> }) {
    const prService = yield* PRService.PRService
    yield* Effect.forkDaemon(prService.setAllAccounts(params.enabled, params.profiles))
  })
)

/**
 * Marks all notifications as read
 * @category atoms
 */
export const markAllReadAtom = runtimeAtom.fn(
  Effect.fnUntraced(function*() {
    const notificationRepo = yield* CacheService.NotificationRepo
    yield* notificationRepo.markAllRead()
  })
)

const emptyNotifications: PaginatedNotifications = { items: [] }

/**
 * Subscribes to notification changes via EventsHub
 * @category atoms
 */
export const notificationsAtom = runtimeAtom.subscribable(
  Effect.gen(function*() {
    const notificationRepo = yield* CacheService.NotificationRepo
    const hub = yield* CacheService.EventsHub

    const initial = yield* notificationRepo.findAll({ limit: 50 }).pipe(
      Effect.catchAll(() => Effect.succeed(emptyNotifications))
    )
    const ref = yield* SubscriptionRef.make(initial)

    yield* Effect.forkDaemon(
      Effect.scoped(
        hub.subscribe.pipe(
          Stream.filter((e) => e._tag === "Notifications" || e._tag === "SystemNotifications"),
          Stream.debounce("200 millis"),
          Stream.runForEach(() =>
            notificationRepo.findAll({ limit: 50 }).pipe(
              Effect.flatMap((result) => SubscriptionRef.set(ref, result)),
              Effect.catchAll(() => Effect.void)
            )
          )
        )
      )
    )

    return ref
  })
)

export type AppState = Domain.AppState
