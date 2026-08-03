import { describe, expect, it } from "@effect/vitest"
import { ConfigService, PRService, SandboxService } from "@knpkv/codecommit-core"
import { Deferred, Effect, Layer, Ref } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { autoRefreshLayer, sandboxStartupLayer } from "../src/server/internal/BackgroundWorkers.js"

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
          yield* Effect.yieldNow
          yield* TestClock.adjust("11 seconds")
          yield* Deferred.await(secondPass)
        }).pipe(
          Effect.provide(autoRefreshLayer.pipe(Layer.provide(dependencies)))
        )
      )

      yield* Deferred.await(finalized)
      expect(yield* Ref.get(attempts)).toBe(2)
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
          yield* TestClock.adjust("5 minutes")
          yield* Deferred.await(firstPass)
          yield* Effect.yieldNow
          yield* TestClock.adjust("5 minutes")
          yield* Deferred.await(secondPass)
        }).pipe(
          Effect.provide(sandboxStartupLayer.pipe(Layer.provide(dependencies)))
        )
      )

      yield* Deferred.await(finalized)
      expect(yield* Ref.get(attempts)).toBe(2)
    }))
})
