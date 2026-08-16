import { describe, expect, it } from "@effect/vitest"
import { ConfigService, PRService, SandboxService } from "@knpkv/codecommit-core"
import type { Duration } from "effect"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
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
            refreshIntervalSeconds: 1,
            review: ConfigService.defaultReviewConfig
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
                  refreshIntervalSeconds: 1,
                  review: ConfigService.defaultReviewConfig
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

  it.effect("waits for legacy sandbox reconciliation before reporting startup readiness", () =>
    Effect.gen(function*() {
      const firstAttempt = yield* Deferred.make<void>()
      const secondAttempt = yield* Deferred.make<void>()
      const ready = yield* Deferred.make<void>()
      const attempts = yield* Ref.make(0)
      const reconcile = () =>
        Ref.getAndUpdate(attempts, (attempt) => attempt + 1).pipe(
          Effect.flatMap((attempt) =>
            Deferred.succeed(attempt === 0 ? firstAttempt : secondAttempt, undefined).pipe(
              Effect.as(attempt > 0)
            )
          )
        )
      const dependencies = Layer.mergeAll(
        Layer.mock(SandboxService.SandboxService, {
          hasLegacyUnauthenticated: () => Effect.succeed(true),
          reconcile,
          gcIdle: () => Effect.void
        }),
        Layer.mock(SandboxService.DockerService, {
          isAvailable: () => Effect.succeed(true)
        })
      )
      const startup = Deferred.succeed(ready, undefined).pipe(
        Effect.provide(sandboxStartupLayer.pipe(Layer.provide(dependencies)))
      )
      const fiber = yield* Effect.forkChild(startup)

      yield* Deferred.await(firstAttempt)
      expect(yield* Deferred.isDone(ready)).toBe(false)
      yield* advanceClockUntil(secondAttempt, "1 second", 3)
      yield* Deferred.await(secondAttempt)
      yield* Deferred.await(ready)
      yield* Fiber.join(fiber)

      expect(yield* Ref.get(attempts)).toBe(2)
    }))

  it.effect("waits for Docker availability before reconciling and reporting readiness", () =>
    Effect.gen(function*() {
      const firstAvailabilityCheck = yield* Deferred.make<void>()
      const secondAvailabilityCheck = yield* Deferred.make<void>()
      const reconciled = yield* Deferred.make<void>()
      const ready = yield* Deferred.make<void>()
      const availabilityAttempts = yield* Ref.make(0)
      const reconcileAttempts = yield* Ref.make(0)
      const dependencies = Layer.mergeAll(
        Layer.mock(SandboxService.SandboxService, {
          hasLegacyUnauthenticated: () => Effect.succeed(true),
          reconcile: () =>
            Ref.update(reconcileAttempts, (attempt) => attempt + 1).pipe(
              Effect.andThen(Deferred.succeed(reconciled, undefined)),
              Effect.as(true)
            ),
          gcIdle: () => Effect.void
        }),
        Layer.mock(SandboxService.DockerService, {
          isAvailable: () =>
            Ref.getAndUpdate(availabilityAttempts, (attempt) => attempt + 1).pipe(
              Effect.flatMap((attempt) =>
                Deferred.succeed(
                  attempt === 0 ? firstAvailabilityCheck : secondAvailabilityCheck,
                  undefined
                ).pipe(Effect.as(attempt > 0))
              )
            )
        })
      )
      const startup = Deferred.succeed(ready, undefined).pipe(
        Effect.provide(sandboxStartupLayer.pipe(Layer.provide(dependencies)))
      )
      const fiber = yield* Effect.forkChild(startup)

      yield* Deferred.await(firstAvailabilityCheck)
      expect(yield* Deferred.isDone(ready)).toBe(false)
      expect(yield* Ref.get(reconcileAttempts)).toBe(0)
      yield* advanceClockUntil(secondAvailabilityCheck, "1 second", 3)
      yield* Deferred.await(secondAvailabilityCheck)
      yield* Deferred.await(reconciled)
      yield* Deferred.await(ready)
      yield* Fiber.join(fiber)

      expect(yield* Ref.get(availabilityAttempts)).toBe(2)
      expect(yield* Ref.get(reconcileAttempts)).toBe(1)
    }))

  it.effect("reports readiness without Docker when no legacy sandbox requires shutdown", () =>
    Effect.gen(function*() {
      const availabilityChecked = yield* Deferred.make<void>()
      const ready = yield* Deferred.make<void>()
      const reconcileAttempts = yield* Ref.make(0)
      const dependencies = Layer.mergeAll(
        Layer.mock(SandboxService.SandboxService, {
          hasLegacyUnauthenticated: () => Effect.succeed(false),
          reconcile: () => Ref.update(reconcileAttempts, (attempt) => attempt + 1).pipe(Effect.as(true)),
          gcIdle: () => Effect.void
        }),
        Layer.mock(SandboxService.DockerService, {
          isAvailable: () => Deferred.succeed(availabilityChecked, undefined).pipe(Effect.as(false))
        })
      )

      const startup = Deferred.succeed(ready, undefined).pipe(
        Effect.provide(sandboxStartupLayer.pipe(Layer.provide(dependencies)))
      )
      const fiber = yield* Effect.forkChild(startup)

      yield* Deferred.await(availabilityChecked)
      yield* Deferred.await(ready)
      yield* Fiber.join(fiber)

      expect(yield* Ref.get(reconcileAttempts)).toBe(0)
    }))

  it.effect("reports startup readiness after one successful sandbox reconciliation", () =>
    Effect.gen(function*() {
      const attempts = yield* Ref.make(0)
      const dependencies = Layer.mergeAll(
        Layer.mock(SandboxService.SandboxService, {
          hasLegacyUnauthenticated: () => Effect.succeed(true),
          reconcile: () => Ref.update(attempts, (attempt) => attempt + 1).pipe(Effect.as(true)),
          gcIdle: () => Effect.void
        }),
        Layer.mock(SandboxService.DockerService, {
          isAvailable: () => Effect.succeed(true)
        })
      )

      yield* Effect.scoped(
        Effect.void.pipe(
          Effect.provide(sandboxStartupLayer.pipe(Layer.provide(dependencies)))
        )
      )

      expect(yield* Ref.get(attempts)).toBe(1)
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
          hasLegacyUnauthenticated: () => Effect.succeed(false),
          reconcile: () => Effect.succeed(true),
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
