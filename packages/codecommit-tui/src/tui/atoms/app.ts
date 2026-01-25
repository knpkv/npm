import type { Atom, Result } from "@effect-atom/atom-react"
import { Effect, Fiber } from "effect"
import { type NotificationsState, NotificationsService } from "../../NotificationsService.js"
import { type AppState, PRService } from "../../PRService.js"
import { runtimeAtom } from "./runtime.js"

// Track active refresh fiber for cleanup
let activeRefreshFiber: Fiber.RuntimeFiber<void, unknown> | null = null

/**
 * Subscribes to PRService.state changes
 * @category atoms
 */
export const appStateAtom: Atom.Atom<Result.Result<AppState>> = runtimeAtom.subscribable(
  Effect.gen(function*() {
    const prService = yield* PRService
    return prService.state
  })
)

/**
 * Triggers a refresh of pull requests
 * @category atoms
 */
export const refreshAtom: Atom.Writable<Result.Result<void>, void> = runtimeAtom.fn(
  Effect.fnUntraced(function*() {
    // Interrupt previous refresh if still running
    if (activeRefreshFiber) {
      yield* Fiber.interrupt(activeRefreshFiber)
      activeRefreshFiber = null
    }
    const prService = yield* PRService
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
export const toggleAccountAtom: Atom.Writable<Result.Result<void>, string> = runtimeAtom.fn(
  Effect.fnUntraced(function*(profile: string) {
    const prService = yield* PRService
    yield* Effect.forkDaemon(prService.toggleAccount(profile))
  })
)

/**
 * Sets all accounts to enabled or disabled
 * @category atoms
 */
export const setAllAccountsAtom: Atom.Writable<Result.Result<void>, { enabled: boolean; profiles?: string[] }> = runtimeAtom.fn(
  Effect.fnUntraced(function*(params: { enabled: boolean; profiles?: string[] }) {
    const prService = yield* PRService
    yield* Effect.forkDaemon(prService.setAllAccounts(params.enabled, params.profiles))
  })
)

/**
 * Clears accumulated notifications
 * @category atoms
 */
export const clearNotificationsAtom: Atom.Writable<Result.Result<void>, void> = runtimeAtom.fn(
  Effect.fnUntraced(function*() {
    const prService = yield* PRService
    yield* prService.clearNotifications
  })
)

/**
 * Subscribes to NotificationsService.state changes
 * @category atoms
 */
export const notificationsAtom: Atom.Atom<Result.Result<NotificationsState>> = runtimeAtom.subscribable(
  Effect.gen(function*() {
    const notificationsService = yield* NotificationsService
    return notificationsService.state
  })
)

export type { AppState, NotificationsState }
