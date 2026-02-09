/**
 * Notification state management service.
 *
 * Manages application notifications using `SubscriptionRef` for reactive state
 * and `Clock.currentTimeMillis` for timestamps (testable with `TestClock`).
 *
 * @example
 * ```typescript
 * import { NotificationsService } from "@knpkv/codecommit-core"
 *
 * const program = Effect.gen(function* () {
 *   const notifications = yield* NotificationsService
 *   yield* notifications.add({ type: "info", title: "Refresh", message: "Complete" })
 * })
 * ```
 *
 * @category Service
 * @module
 */
import { Clock, Context, DateTime, Effect, Layer, SubscriptionRef } from "effect"
import type { NotificationItem, NotificationsState, NotificationType } from "./Domain.js"

// ---------------------------------------------------------------------------
// Service Definition
// ---------------------------------------------------------------------------

/**
 * Notifications service.
 *
 * @category Service
 */
export class NotificationsService extends Context.Tag("@knpkv/codecommit-core/NotificationsService")<
  NotificationsService,
  {
    readonly state: SubscriptionRef.SubscriptionRef<NotificationsState>
    readonly add: (item: {
      readonly type: NotificationType
      readonly title: string
      readonly message: string
      readonly profile?: string
    }) => Effect.Effect<void>
    readonly clear: Effect.Effect<void>
  }
>() {}

// ---------------------------------------------------------------------------
// Live Implementation
// ---------------------------------------------------------------------------

/**
 * Live notifications service using Clock for timestamps.
 *
 * @category Service
 */
export const NotificationsServiceLive = Layer.effect(
  NotificationsService,
  Effect.gen(function*() {
    const state = yield* SubscriptionRef.make<NotificationsState>({
      items: []
    })

    const add = (item: {
      readonly type: NotificationType
      readonly title: string
      readonly message: string
      readonly profile?: string
    }): Effect.Effect<void> =>
      Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        const timestamp = DateTime.toDate(DateTime.unsafeMake(now))
        const notification: NotificationItem = {
          ...item,
          timestamp
        }
        yield* SubscriptionRef.update(state, (s) => ({
          items: [...s.items, notification].slice(-100)
        }))
      }).pipe(Effect.withSpan("NotificationsService.add"))

    const clear = SubscriptionRef.update(state, () => ({ items: [] }))

    return { state, add, clear }
  })
)
