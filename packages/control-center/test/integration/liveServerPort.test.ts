import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"

import { startWithRetriedPort } from "./liveServerPort.js"

describe("live integration server port", () => {
  it.effect("reacquires a port after a bind conflict", () => {
    let nextPort = 41_700
    let initialized = false
    let cleanups = 0
    const attemptedPorts: Array<number> = []
    return Effect.scoped(
      Effect.gen(function*() {
        const started = yield* startWithRetriedPort(
          Effect.sync(() => nextPort++),
          (port) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                assert.isFalse(initialized)
                initialized = true
                attemptedPorts.push(port)
                return port
              }),
              () =>
                Effect.sync(() => {
                  initialized = false
                  cleanups += 1
                })
            ).pipe(
              Effect.flatMap((acquiredPort) =>
                acquiredPort === 41_700
                  ? Effect.fail({ code: "EADDRINUSE" })
                  : Effect.succeed(`http://127.0.0.1:${acquiredPort}`)
              )
            )
        )

        assert.deepStrictEqual(attemptedPorts, [41_700, 41_701])
        assert.strictEqual(started.port, 41_701)
        assert.strictEqual(started.value, "http://127.0.0.1:41701")
        assert.isTrue(initialized)
        assert.strictEqual(cleanups, 1)
      })
    ).pipe(
      Effect.andThen(
        Effect.sync(() => {
          assert.isFalse(initialized)
          assert.strictEqual(cleanups, 2)
        })
      )
    )
  })

  it.effect("does not retry unrelated startup failures", () =>
    Effect.scoped(
      Effect.gen(function*() {
        let attempts = 0
        const result = yield* startWithRetriedPort(
          Effect.succeed(41_700),
          () => {
            attempts += 1
            return Effect.fail({ code: "EACCES" })
          }
        ).pipe(Effect.result)

        assert.strictEqual(result._tag, "Failure")
        assert.strictEqual(attempts, 1)
      })
    ))
})
