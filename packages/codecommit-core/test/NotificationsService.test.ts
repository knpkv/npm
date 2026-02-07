import { describe, expect, it } from "@effect/vitest"
import { Effect, SubscriptionRef, TestClock } from "effect"
import { NotificationsService, NotificationsServiceLive } from "../src/NotificationsService.js"

describe("NotificationsService", () => {
  // add() must append notification item with Clock-derived timestamp
  it.effect("adds notification with timestamp from TestClock", () =>
    Effect.gen(function*() {
      const service = yield* NotificationsService

      // Advance TestClock to a known point so timestamp is deterministic
      yield* TestClock.adjust("10 seconds")
      yield* service.add({ type: "info", title: "Test", message: "Hello" })

      const state = yield* SubscriptionRef.get(service.state)
      expect(state.items).toHaveLength(1)
      expect(state.items[0]!.title).toBe("Test")
      expect(state.items[0]!.message).toBe("Hello")
      expect(state.items[0]!.type).toBe("info")
      // Timestamp should be non-zero (10s after epoch)
      expect(state.items[0]!.timestamp.getTime()).toBe(10_000)
    }).pipe(Effect.provide(NotificationsServiceLive)))

  // Multiple adds must accumulate — state is append-only until clear
  it.effect("accumulates multiple notifications", () =>
    Effect.gen(function*() {
      const service = yield* NotificationsService

      yield* service.add({ type: "error", title: "Err1", message: "fail" })
      yield* service.add({ type: "warning", title: "Warn1", message: "caution" })

      const state = yield* SubscriptionRef.get(service.state)
      expect(state.items).toHaveLength(2)
      expect(state.items[0]!.type).toBe("error")
      expect(state.items[1]!.type).toBe("warning")
    }).pipe(Effect.provide(NotificationsServiceLive)))

  // clear() must reset items to empty array
  it.effect("clears all notifications", () =>
    Effect.gen(function*() {
      const service = yield* NotificationsService

      yield* service.add({ type: "info", title: "T", message: "M" })
      yield* service.clear

      const state = yield* SubscriptionRef.get(service.state)
      expect(state.items).toHaveLength(0)
    }).pipe(Effect.provide(NotificationsServiceLive)))
})
