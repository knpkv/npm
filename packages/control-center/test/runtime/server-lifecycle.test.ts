import { assert, describe, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Result from "effect/Result"
import * as TestClock from "effect/testing/TestClock"

import { ServerDraining, ServerLifecycle } from "../../src/server/runtime/ServerLifecycle.js"

describe("server lifecycle", () => {
  it.effect("stops new work while allowing an admitted mutation to finish", () =>
    Effect.gen(function*() {
      const lifecycle = yield* ServerLifecycle
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const mutation = yield* lifecycle.runMutation(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
      ).pipe(Effect.forkChild)

      yield* Deferred.await(entered)
      yield* lifecycle.beginDrain
      yield* lifecycle.awaitDrain

      assert.strictEqual(yield* lifecycle.phase, "draining")

      const waiting = yield* lifecycle.awaitMutationsDrained.pipe(Effect.forkChild)
      yield* Effect.yieldNow
      assert.isUndefined(waiting.pollUnsafe())

      const rejectedMutation = yield* lifecycle.runMutation(Effect.void).pipe(Effect.result)
      assert.isTrue(Result.isFailure(rejectedMutation))
      if (Result.isFailure(rejectedMutation)) {
        assert.instanceOf(rejectedMutation.failure, ServerDraining)
      }

      const rejectedStream = yield* Effect.scoped(lifecycle.acquireStream).pipe(Effect.result)
      assert.isTrue(Result.isFailure(rejectedStream))
      if (Result.isFailure(rejectedStream)) {
        assert.instanceOf(rejectedStream.failure, ServerDraining)
      }

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(mutation)
      yield* Fiber.join(waiting)
    }).pipe(Effect.provide(ServerLifecycle.layer)))

  it.effect("releases interrupted mutations from the drain barrier", () =>
    Effect.gen(function*() {
      const lifecycle = yield* ServerLifecycle
      const entered = yield* Deferred.make<void>()
      const mutation = yield* lifecycle.runMutation(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
      ).pipe(Effect.forkChild)

      yield* Deferred.await(entered)
      yield* lifecycle.beginDrain
      yield* Fiber.interrupt(mutation)
      yield* lifecycle.awaitMutationsDrained
    }).pipe(Effect.provide(ServerLifecycle.layer)))

  it.effect("honors the hard drain deadline without abandoning lifecycle accounting", () =>
    Effect.gen(function*() {
      const lifecycle = yield* ServerLifecycle
      const entered = yield* Deferred.make<void>()
      const mutation = yield* lifecycle.runMutation(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
      ).pipe(Effect.forkChild)

      yield* Deferred.await(entered)
      const drain = yield* lifecycle.drainWithin(Duration.seconds(10)).pipe(Effect.forkChild)
      yield* TestClock.adjust(Duration.seconds(10))

      assert.isFalse(yield* Fiber.join(drain))
      assert.strictEqual(yield* lifecycle.phase, "draining")

      yield* Fiber.interrupt(mutation)
      yield* lifecycle.awaitMutationsDrained
    }).pipe(Effect.provide(ServerLifecycle.layer)))
})
