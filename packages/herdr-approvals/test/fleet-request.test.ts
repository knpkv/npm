import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { withFleetRequestTimeout } from "../src/internal/fleet-request.js"

describe("fleet request deadline", () => {
  it.effect("covers body consumption inside the request timeout", () =>
    Effect.gen(function*() {
      const bodyStarted = yield* Deferred.make<void>()
      const resultFiber = yield* Effect.forkChild(
        Effect.result(
          withFleetRequestTimeout(
            Deferred.succeed(bodyStarted, undefined).pipe(
              Effect.andThen(Effect.never)
            )
          )
        )
      )
      yield* Deferred.await(bodyStarted)
      yield* TestClock.adjust("10 seconds")
      expect(yield* Fiber.join(resultFiber)).toMatchObject({
        failure: { operation: "fleet.request.timeout" }
      })
      expect(yield* withFleetRequestTimeout(Effect.succeed("decoded")))
        .toBe("decoded")
    }))
})
