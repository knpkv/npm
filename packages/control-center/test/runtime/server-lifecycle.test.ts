import { assert, describe, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as TestClock from "effect/testing/TestClock"

import { ServerDrainHookConflict, ServerDraining, ServerLifecycle } from "../../src/server/runtime/ServerLifecycle.js"

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

  it.effect("keeps nested work admitted when drain begins inside an active mutation", () =>
    Effect.gen(function*() {
      const lifecycle = yield* ServerLifecycle
      const entered = yield* Deferred.make<void>()
      const continueMutation = yield* Deferred.make<void>()
      const mutation = yield* lifecycle.runMutation(
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(continueMutation)),
          Effect.andThen(lifecycle.runMutation(Effect.succeed("completed")))
        )
      ).pipe(Effect.forkChild)

      yield* Deferred.await(entered)
      yield* lifecycle.beginDrain
      yield* Deferred.succeed(continueMutation, undefined)

      assert.strictEqual(yield* Fiber.join(mutation), "completed")
      yield* lifecycle.awaitMutationsDrained

      const rejectedMutation = yield* lifecycle.runMutation(Effect.void).pipe(Effect.result)
      assert.isTrue(Result.isFailure(rejectedMutation))
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

  it.effect("stops new background jobs and includes admitted jobs in the drain barrier", () =>
    Effect.gen(function*() {
      const lifecycle = yield* ServerLifecycle
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const backgroundJob = yield* lifecycle.runBackground(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
      ).pipe(Effect.forkChild)

      yield* Deferred.await(entered)
      yield* lifecycle.beginDrain

      const mutationsWaiting = yield* lifecycle.awaitMutationsDrained.pipe(Effect.forkChild)
      const waiting = yield* lifecycle.awaitWorkDrained.pipe(Effect.forkChild)
      const drain = yield* lifecycle.drainWithin(Duration.seconds(10)).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      assert.isDefined(mutationsWaiting.pollUnsafe())
      assert.isUndefined(waiting.pollUnsafe())

      yield* TestClock.adjust(Duration.seconds(10))
      assert.deepStrictEqual(yield* Fiber.join(drain), { _tag: "DeadlineExceeded" })

      const rejected = yield* lifecycle.runBackground(Effect.void).pipe(Effect.result)
      assert.isTrue(Result.isFailure(rejected))
      if (Result.isFailure(rejected)) {
        assert.instanceOf(rejected.failure, ServerDraining)
      }

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(mutationsWaiting)
      yield* Fiber.join(backgroundJob)
      yield* Fiber.join(waiting)
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

      assert.deepStrictEqual(yield* Fiber.join(drain), { _tag: "DeadlineExceeded" })
      assert.strictEqual(yield* lifecycle.phase, "draining")

      yield* Fiber.interrupt(mutation)
      yield* lifecycle.awaitMutationsDrained
    }).pipe(Effect.provide(ServerLifecycle.layer)))

  it.effect("runs a stable hook snapshot once after admitted work drains", () =>
    Effect.scoped(Effect.gen(function*() {
      const lifecycle = yield* ServerLifecycle.make
      const events = yield* Ref.make<ReadonlyArray<string>>([])
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const record = (event: string) => Ref.update(events, (current) => [...current, event])

      yield* lifecycle.registerDrainHook({
        hookId: "z-failing",
        run: record("z-failing").pipe(Effect.andThen(Effect.die("injected-hook-defect")))
      })
      yield* lifecycle.registerDrainHook({
        hookId: "a-flush",
        run: record("a-flush")
      })
      const background = yield* lifecycle.runBackground(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
      ).pipe(Effect.forkChild)
      yield* Deferred.await(entered)

      const draining = yield* lifecycle.drainWithin("10 seconds").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      assert.deepStrictEqual(yield* Ref.get(events), [])

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(background)
      assert.deepStrictEqual(yield* Fiber.join(draining), {
        _tag: "HooksFailed",
        hookIds: ["z-failing"]
      })
      assert.deepStrictEqual(yield* lifecycle.drainWithin("10 seconds"), {
        _tag: "HooksFailed",
        hookIds: ["z-failing"]
      })
      assert.deepStrictEqual(yield* Ref.get(events), ["a-flush", "z-failing"])
    })))

  it.effect("rejects conflicting or late drain hook registrations", () =>
    Effect.scoped(Effect.gen(function*() {
      const lifecycle = yield* ServerLifecycle.make
      yield* lifecycle.registerDrainHook({ hookId: "persistence", run: Effect.void })

      const conflict = yield* lifecycle.registerDrainHook({
        hookId: "persistence",
        run: Effect.void
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(conflict))
      if (Result.isFailure(conflict)) {
        assert.instanceOf(conflict.failure, ServerDrainHookConflict)
      }

      yield* lifecycle.beginDrain
      const late = yield* lifecycle.registerDrainHook({
        hookId: "late",
        run: Effect.void
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(late))
      if (Result.isFailure(late)) {
        assert.instanceOf(late.failure, ServerDraining)
      }
    })))

  it.effect("keeps a hanging flush hook inside the hard deadline", () =>
    Effect.scoped(Effect.gen(function*() {
      const lifecycle = yield* ServerLifecycle.make
      yield* lifecycle.registerDrainHook({ hookId: "hanging", run: Effect.never })

      const draining = yield* lifecycle.drainWithin("10 seconds").pipe(Effect.forkChild)
      yield* TestClock.adjust("10 seconds")

      assert.deepStrictEqual(yield* Fiber.join(draining), { _tag: "DeadlineExceeded" })
    })))

  it.effect("waits for admitted streams before running flush hooks", () =>
    Effect.scoped(Effect.gen(function*() {
      const lifecycle = yield* ServerLifecycle.make
      const hookRan = yield* Deferred.make<void>()
      const streamEntered = yield* Deferred.make<void>()
      const releaseStream = yield* Deferred.make<void>()
      yield* lifecycle.registerDrainHook({
        hookId: "flush",
        run: Deferred.succeed(hookRan, undefined).pipe(Effect.asVoid)
      })
      const stream = yield* Effect.scoped(
        lifecycle.acquireStream.pipe(
          Effect.andThen(Deferred.succeed(streamEntered, undefined)),
          Effect.andThen(Deferred.await(releaseStream))
        )
      ).pipe(Effect.forkChild)
      yield* Deferred.await(streamEntered)

      const draining = yield* lifecycle.drainWithin("10 seconds").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      assert.isFalse(Deferred.isDoneUnsafe(hookRan))

      yield* Deferred.succeed(releaseStream, undefined)
      yield* Fiber.join(stream)
      assert.deepStrictEqual(yield* Fiber.join(draining), { _tag: "Drained" })
      assert.isTrue(Deferred.isDoneUnsafe(hookRan))
    })))
})
