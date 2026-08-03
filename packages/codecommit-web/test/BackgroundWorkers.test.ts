import { describe, expect, it } from "@effect/vitest"
import { ConfigService, PRService, SandboxService } from "@knpkv/codecommit-core"
import type { Duration } from "effect"
import { Deferred, Effect, Layer, Ref } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { autoRefreshLayer, sandboxStartupLayer } from "../src/server/internal/BackgroundWorkers.js"

const advanceClockUntil = (
  signal: Deferred.Deferred<void>,
  step: Duration.DurationInput,
  maximumSteps: number
) =>
  Effect.gen(function*() {
    for (let stepNumber = 0; stepNumber < maximumSteps; stepNumber++) {
      if (yield* Deferred.isDone(signal)) {
        return
      }
      yield* TestClock.adjust(step)
    }
    if (!(yield* Deferred.isDone(signal))) {
      return yield* Effect.die(
        new Error(`Signal did not complete after ${maximumSteps} clock adjustments`)
      )
    }
  })

describe("background workers", () => {
  it.effect("supervises the actual auto-refresh worker and interrupts it with the layer", () =>
    Effect.gen(function*() {
      const firstPass = yield* Deferred.make<void>()
      const secondPass = yield* Deferred.make<void>()
      const finalized = yield* Deferred.make<void>()
      const attempts = yield* Ref.make(0)
      const refresh = Ref.getAndUpdate(attempts, (attempt) => attempt + 1).pipe(
        Effect.flatMap((attempt) =>
          attempt === 0
            ? Deferred.succeed(firstPass, undefined).pipe(
              Effect.andThen(Effect.die("initial refresh defect"))
            )
            : Deferred.succeed(secondPass, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(finalized, undefined))
            )
        )
      )
      const dependencies = Layer.mergeAll(
        Layer.mock(PRService.PRService, { refresh }),
        Layer.mock(ConfigService.ConfigService, {
          load: Effect.succeed({
            autoRefresh: true,
            refreshIntervalSeconds: 1
          })
        })
      )

      yield* Effect.scoped(
        Effect.gen(function*() {
          yield* Deferred.await(firstPass)
          yield* advanceClockUntil(secondPass, "1 second", 15)
          yield* Deferred.await(secondPass)
        }).pipe(
          Effect.provide(autoRefreshLayer.pipe(Layer.provide(dependencies)))
        )
      )

      yield* Deferred.await(finalized)
      expect(yield* Ref.get(attempts)).toBe(2)
    }))

  it.effect("recovers when config loading defects and refreshes on the next iteration", () =>
    Effect.gen(function*() {
      const initialRefresh = yield* Deferred.make<void>()
      const loaderDefected = yield* Deferred.make<void>()
      const refreshAfterRecovery = yield* Deferred.make<void>()
      const loadAttempts = yield* Ref.make(0)
      const refreshAttempts = yield* Ref.make(0)
      const dependencies = Layer.mergeAll(
        Layer.mock(PRService.PRService, {
          refresh: Ref.getAndUpdate(refreshAttempts, (attempt) => attempt + 1).pipe(
            Effect.flatMap((attempt) =>
              Deferred.succeed(
                attempt === 0 ? initialRefresh : refreshAfterRecovery,
                undefined
              )
            )
          )
        }),
        Layer.mock(ConfigService.ConfigService, {
          load: Ref.getAndUpdate(loadAttempts, (attempt) => attempt + 1).pipe(
            Effect.flatMap((attempt) =>
              attempt === 0
                ? Deferred.succeed(loaderDefected, undefined).pipe(
                  Effect.andThen(Effect.die("config loader defect"))
                )
                : Effect.succeed({
                  autoRefresh: true,
                  refreshIntervalSeconds: 1
                })
            )
          )
        })
      )

      yield* Effect.scoped(
        Effect.gen(function*() {
          yield* Deferred.await(initialRefresh)
          yield* Deferred.await(loaderDefected)
          yield* advanceClockUntil(refreshAfterRecovery, "1 second", 15)
          yield* Deferred.await(refreshAfterRecovery)
        }).pipe(
          Effect.provide(autoRefreshLayer.pipe(Layer.provide(dependencies)))
        )
      )

      expect(yield* Ref.get(loadAttempts)).toBeGreaterThanOrEqual(2)
      expect(yield* Ref.get(refreshAttempts)).toBe(2)
    }))

  it.effect("uses the default refresh configuration when config loading fails", () =>
    Effect.gen(function*() {
      const initialRefresh = yield* Deferred.make<void>()
      const defaultIntervalRefresh = yield* Deferred.make<void>()
      const refreshAttempts = yield* Ref.make(0)
      const dependencies = Layer.mergeAll(
        Layer.mock(PRService.PRService, {
          refresh: Ref.getAndUpdate(refreshAttempts, (attempt) => attempt + 1).pipe(
            Effect.flatMap((attempt) =>
              Deferred.succeed(
                attempt === 0 ? initialRefresh : defaultIntervalRefresh,
                undefined
              )
            )
          )
        }),
        Layer.mock(ConfigService.ConfigService, {
          load: Effect.fail("typed config load failure")
        })
      )

      yield* Effect.scoped(
        Effect.gen(function*() {
          yield* Deferred.await(initialRefresh)
          yield* advanceClockUntil(defaultIntervalRefresh, "1 minute", 7)
          yield* Deferred.await(defaultIntervalRefresh)
        }).pipe(
          Effect.provide(autoRefreshLayer.pipe(Layer.provide(dependencies)))
        )
      )

      expect(yield* Ref.get(refreshAttempts)).toBe(2)
    }))

  it.effect("supervises the actual sandbox GC worker and interrupts it with the layer", () =>
    Effect.gen(function*() {
      const firstPass = yield* Deferred.make<void>()
      const secondPass = yield* Deferred.make<void>()
      const finalized = yield* Deferred.make<void>()
      const attempts = yield* Ref.make(0)
      const gcIdle = () =>
        Ref.getAndUpdate(attempts, (attempt) => attempt + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt === 0
              ? Deferred.succeed(firstPass, undefined).pipe(
                Effect.andThen(Effect.die("sandbox GC defect"))
              )
              : Deferred.succeed(secondPass, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(finalized, undefined))
              )
          )
        )
      const dependencies = Layer.mergeAll(
        Layer.mock(SandboxService.SandboxService, {
          reconcile: () => Effect.void,
          gcIdle
        }),
        Layer.mock(SandboxService.DockerService, {
          isAvailable: () => Effect.succeed(true)
        })
      )

      yield* Effect.scoped(
        Effect.gen(function*() {
          yield* advanceClockUntil(firstPass, "1 minute", 7)
          yield* Deferred.await(firstPass)
          yield* advanceClockUntil(secondPass, "1 minute", 7)
          yield* Deferred.await(secondPass)
        }).pipe(
          Effect.provide(sandboxStartupLayer.pipe(Layer.provide(dependencies)))
        )
      )

      yield* Deferred.await(finalized)
      expect(yield* Ref.get(attempts)).toBe(2)
    }))
})
