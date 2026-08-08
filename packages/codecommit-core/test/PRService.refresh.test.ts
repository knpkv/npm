import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, SubscriptionRef } from "effect"
import { AwsClient } from "../src/AwsClient/index.js"
import { EventsHub } from "../src/CacheService/EventsHub.js"
import { CommentRepo } from "../src/CacheService/repos/CommentRepo.js"
import { NotificationRepo } from "../src/CacheService/repos/NotificationRepo.js"
import { PullRequestRepo } from "../src/CacheService/repos/PullRequestRepo/index.js"
import { SubscriptionRepo } from "../src/CacheService/repos/SubscriptionRepo.js"
import { SyncMetadataRepo } from "../src/CacheService/repos/SyncMetadataRepo.js"
import { ConfigService } from "../src/ConfigService/index.js"
import type { AppState } from "../src/Domain.js"
import { makeRefresh } from "../src/PRService/refresh.js"

const dependencies = (load: ConfigService["Service"]["load"]) =>
  Layer.mergeAll(
    Layer.mock(AwsClient, {}),
    Layer.mock(EventsHub, {}),
    Layer.mock(CommentRepo, {}),
    Layer.mock(NotificationRepo, {}),
    Layer.mock(PullRequestRepo, {
      findAll: () => Effect.succeed([])
    }),
    Layer.mock(SubscriptionRepo, {}),
    Layer.mock(SyncMetadataRepo, {}),
    Layer.mock(ConfigService, { load })
  )

const makeState = SubscriptionRef.make<AppState>({
  pullRequests: [],
  accounts: [],
  status: "idle"
})

describe("PRService.refresh", () => {
  it.effect("records an unexpected defect while preserving its original Cause", () =>
    Effect.gen(function*() {
      const defect = new Error("config defect")
      const state = yield* makeState

      const exit = yield* makeRefresh(state).pipe(
        Effect.provide(dependencies(Effect.die(defect))),
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons).toHaveLength(1)
        const [reason] = exit.cause.reasons
        expect(reason && Cause.isDieReason(reason)).toBe(true)
        if (reason && Cause.isDieReason(reason)) {
          expect(reason.defect).toBe(defect)
        }
      }
      expect(yield* SubscriptionRef.get(state)).toMatchObject({
        status: "error",
        error: "config defect"
      })
    }))

  it.effect("preserves an unprintable defect and records a safe fallback error", () =>
    Effect.gen(function*() {
      const defect = {
        toString(): string {
          throw new Error("formatter defect")
        }
      }
      const state = yield* makeState

      const exit = yield* makeRefresh(state).pipe(
        Effect.provide(dependencies(Effect.die(defect))),
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const [reason] = exit.cause.reasons
        expect(reason && Cause.isDieReason(reason)).toBe(true)
        if (reason && Cause.isDieReason(reason)) {
          expect(reason.defect).toBe(defect)
        }
      }
      expect(yield* SubscriptionRef.get(state)).toMatchObject({
        status: "error",
        error: "Unknown error"
      })
    }))

  it.effect("preserves a defect with a Symbol message and records its string representation", () =>
    Effect.gen(function*() {
      const defect = new Error("original message")
      Object.defineProperty(defect, "message", { value: Symbol("hostile message") })
      const state = yield* makeState

      const exit = yield* makeRefresh(state).pipe(
        Effect.provide(dependencies(Effect.die(defect))),
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const [reason] = exit.cause.reasons
        expect(reason && Cause.isDieReason(reason)).toBe(true)
        if (reason && Cause.isDieReason(reason)) {
          expect(reason.defect).toBe(defect)
        }
      }
      const finalState = yield* SubscriptionRef.get(state)
      expect(finalState).toMatchObject({
        status: "error",
        error: "Symbol(hostile message)"
      })
      expect(typeof finalState.error).toBe("string")
    }))

  it.effect("preserves interruption without recording it as a refresh error", () =>
    Effect.gen(function*() {
      const interruption = Cause.interrupt(841)
      const state = yield* makeState

      const exit = yield* makeRefresh(state).pipe(
        Effect.provide(dependencies(Effect.failCause(interruption))),
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect([...Cause.interruptors(exit.cause)]).toEqual([841])
      }
      expect(yield* SubscriptionRef.get(state)).toMatchObject({
        status: "loading"
      })
      expect((yield* SubscriptionRef.get(state)).error).toBeUndefined()
    }))
})
