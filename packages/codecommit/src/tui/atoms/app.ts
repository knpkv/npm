import { type Domain, NotificationsService, PRService } from "@knpkv/codecommit-core"
import { Effect, Fiber } from "effect"
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
 * Clears accumulated notifications
 * @category atoms
 */
export const clearNotificationsAtom = runtimeAtom.fn(
  Effect.fnUntraced(function*() {
    const prService = yield* PRService.PRService
    yield* prService.clearNotifications
  })
)

/**
 * Subscribes to NotificationsService.state changes
 * @category atoms
 */
export const notificationsAtom = runtimeAtom.subscribable(
  Effect.gen(function*() {
    const notificationsService = yield* NotificationsService.NotificationsService
    return notificationsService.state
  })
)

export type AppState = Domain.AppState
export type NotificationsState = Domain.NotificationsState
