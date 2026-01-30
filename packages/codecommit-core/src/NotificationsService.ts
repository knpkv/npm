import { Context, Effect, Layer, SubscriptionRef } from "effect"

export interface NotificationItem {
  readonly type: "error" | "info" | "warning" | "success"
  readonly title: string
  readonly message: string
  readonly timestamp: Date
}

export interface NotificationsState {
  readonly items: ReadonlyArray<NotificationItem>
}

export class NotificationsService extends Context.Tag("NotificationsService")<
  NotificationsService,
  {
    readonly state: SubscriptionRef.SubscriptionRef<NotificationsState>
    readonly add: (item: Omit<NotificationItem, "timestamp">) => Effect.Effect<void>
    readonly clear: Effect.Effect<void>
  }
>() {}

export const NotificationsServiceLive = Layer.effect(
  NotificationsService,
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make<NotificationsState>({
      items: []
    })

    const add = (item: Omit<NotificationItem, "timestamp">) =>
      SubscriptionRef.update(state, (s) => ({
        items: [...s.items, { ...item, timestamp: new Date() }]
      }))

    const clear = SubscriptionRef.update(state, (s) => ({ items: [] }))

    return { state, add, clear }
  })
)
