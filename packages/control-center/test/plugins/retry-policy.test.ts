import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Fiber, Random, Ref, Result, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"

import { PluginActionReconciliationKey } from "../../src/domain/plugins/actions.js"
import {
  PluginAuthenticationFailure,
  PluginAuthorizationFailure,
  PluginConflictFailure,
  type PluginFailure,
  PluginMalformedResponseFailure,
  PluginOutageFailure,
  PluginRateLimitFailure,
  PluginUnknownOutcomeFailure
} from "../../src/server/plugins/failures.js"
import {
  isPluginFailureRetryable,
  PLUGIN_OPERATION_MAX_ATTEMPTS,
  PLUGIN_RETRY_BASE_DELAY_MILLIS,
  PLUGIN_RETRY_MAX_DELAY_MILLIS,
  retryPluginOperation,
  retryPluginStream
} from "../../src/server/plugins/retryPolicy.js"

const nonRetryableFailures: ReadonlyArray<PluginFailure> = [
  new PluginAuthenticationFailure({ operation: "read" }),
  new PluginAuthorizationFailure({ operation: "read" }),
  new PluginMalformedResponseFailure({
    operation: "read",
    diagnosticCode: "invalid-provider-payload"
  }),
  new PluginConflictFailure({ operation: "write", diagnosticCode: "revision-conflict" }),
  new PluginUnknownOutcomeFailure({
    operation: "write",
    reconciliationKey: PluginActionReconciliationKey.make("operation-1")
  })
]

describe("plugin retry policy", () => {
  it("never retries terminal failures or unsafe mutations", () => {
    for (const failure of nonRetryableFailures) {
      assert.isFalse(isPluginFailureRetryable("safe-read", failure))
      assert.isFalse(isPluginFailureRetryable("idempotent-write", failure))
    }
    assert.isFalse(isPluginFailureRetryable("unsafe-mutation", new PluginOutageFailure({ operation: "dispatch" })))
  })

  it.effect("stops after three total safe-operation attempts", () =>
    Effect.gen(function*() {
      const attempts = yield* Ref.make(0)
      const operation = Ref.update(attempts, (count) => count + 1).pipe(
        Effect.andThen(Effect.fail(new PluginOutageFailure({ operation: "sync" })))
      )
      const fiber = yield* Effect.forkChild(
        retryPluginOperation({
          operation,
          safety: "safe-read"
        })
      )

      yield* TestClock.adjust("1 second")
      const outcome = yield* Fiber.join(fiber).pipe(Effect.result)

      assert.isTrue(Result.isFailure(outcome))
      assert.strictEqual(yield* Ref.get(attempts), PLUGIN_OPERATION_MAX_ATTEMPTS)
    }))

  it.effect("draws non-rate-limit delay from the full-jitter bounds", () =>
    Effect.gen(function*() {
      const attempts = yield* Ref.make(0)
      const operation = Ref.updateAndGet(attempts, (count) => count + 1).pipe(
        Effect.flatMap((attempt) =>
          attempt === 1 ? Effect.fail(new PluginOutageFailure({ operation: "sync" })) : Effect.succeed("accepted")
        )
      )
      const fiber = yield* Effect.forkChild(retryPluginOperation({ operation, safety: "safe-read" }))

      yield* TestClock.adjust(PLUGIN_RETRY_BASE_DELAY_MILLIS - 1)
      assert.strictEqual(yield* Ref.get(attempts), 1)
      yield* TestClock.adjust(1)

      assert.strictEqual(yield* Fiber.join(fiber), "accepted")
      assert.strictEqual(yield* Ref.get(attempts), 2)
      assert.isAtMost(PLUGIN_RETRY_BASE_DELAY_MILLIS, PLUGIN_RETRY_MAX_DELAY_MILLIS)
    }).pipe(
      Effect.provideService(Random.Random, {
        nextIntUnsafe: () => 0,
        nextDoubleUnsafe: () => 1 - Number.EPSILON
      })
    ))

  it.effect("does not retry before the decoded Retry-After instant", () =>
    Effect.gen(function*() {
      const attempts = yield* Ref.make(0)
      const retryAt = DateTime.makeUnsafe("1970-01-01T00:00:05.000Z")
      const operation = Ref.updateAndGet(attempts, (count) => count + 1).pipe(
        Effect.flatMap((attempt) =>
          attempt === 1
            ? Effect.fail(new PluginRateLimitFailure({ operation: "sync", retryAt }))
            : Effect.succeed("accepted")
        )
      )
      const fiber = yield* Effect.forkChild(
        retryPluginOperation({
          operation,
          safety: "safe-read"
        })
      )

      yield* TestClock.adjust("4999 millis")
      assert.strictEqual(yield* Ref.get(attempts), 1)
      yield* TestClock.adjust("1 millis")

      assert.strictEqual(yield* Fiber.join(fiber), "accepted")
      assert.strictEqual(yield* Ref.get(attempts), 2)
    }))

  it.effect("fails instead of retaining a fiber for a far-future Retry-After", () =>
    Effect.gen(function*() {
      const attempts = yield* Ref.make(0)
      const retryAt = DateTime.makeUnsafe("1970-01-01T00:00:20.001Z")
      const outcome = yield* retryPluginOperation({
        operation: Ref.update(attempts, (count) => count + 1).pipe(
          Effect.andThen(Effect.fail(new PluginRateLimitFailure({ operation: "sync", retryAt })))
        ),
        safety: "safe-read"
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(outcome))
      assert.strictEqual(yield* Ref.get(attempts), 1)
    }))

  it.effect("applies the same bounded policy to safe plugin streams", () =>
    Effect.gen(function*() {
      const attempts = yield* Ref.make(0)
      const stream = Stream.fromEffect(
        Ref.update(attempts, (count) => count + 1).pipe(
          Effect.andThen(Effect.fail(new PluginOutageFailure({ operation: "sync" })))
        )
      )
      const fiber = yield* retryPluginStream({ stream, safety: "safe-read" }).pipe(Stream.runDrain, Effect.forkChild)

      yield* TestClock.adjust("1 second")
      const outcome = yield* Fiber.join(fiber).pipe(Effect.result)

      assert.isTrue(Result.isFailure(outcome))
      assert.strictEqual(yield* Ref.get(attempts), PLUGIN_OPERATION_MAX_ATTEMPTS)
    }))

  it.effect("never restarts a stream after it emitted a page", () =>
    Effect.gen(function*() {
      const attempts = yield* Ref.make(0)
      const values = yield* Ref.make<ReadonlyArray<string>>([])
      const stream = Stream.unwrap(
        Ref.update(attempts, (count) => count + 1).pipe(
          Effect.as(
            Stream.make("page-1").pipe(Stream.concat(Stream.fail(new PluginOutageFailure({ operation: "sync" }))))
          )
        )
      )
      const outcome = yield* retryPluginStream({ stream, safety: "safe-read" }).pipe(
        Stream.tap((value) => Ref.update(values, (current) => [...current, value])),
        Stream.runDrain,
        Effect.result
      )

      assert.isTrue(Result.isFailure(outcome))
      assert.strictEqual(yield* Ref.get(attempts), 1)
      assert.deepStrictEqual(yield* Ref.get(values), ["page-1"])
    }))

  it.effect("runs an unsafe mutation once even for a transient outage", () =>
    Effect.gen(function*() {
      const attempts = yield* Ref.make(0)
      const operation = Ref.update(attempts, (count) => count + 1).pipe(
        Effect.andThen(Effect.fail(new PluginOutageFailure({ operation: "dispatch" })))
      )
      const outcome = yield* retryPluginOperation({
        operation,
        safety: "unsafe-mutation"
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(outcome))
      assert.strictEqual(yield* Ref.get(attempts), 1)
    }))
})
