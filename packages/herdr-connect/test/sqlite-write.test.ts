import { describe, expect, it } from "@effect/vitest"
import { Data, Effect, Fiber, Result } from "effect"
import { TestClock } from "effect/testing"
import { connectSqliteWrite } from "../src/internal/sqlite-write.js"

class DriverContention extends Data.TaggedError("DriverContention")<{
  readonly code: "ERR_SQLITE_ERROR"
  readonly errcode: number
}> {}
class OtherSqliteFailure extends Data.TaggedError("OtherSqliteFailure")<{ readonly cause: unknown }> {}

describe("Connect SQLite write classification", () => {
  it.effect.each([5, 6, 261, 262])(
    "retries primary and extended contention code %s",
    (errcode) =>
      Effect.gen(function*() {
        let attempts = 0
        const pending = yield* Effect.forkScoped(Effect.result(connectSqliteWrite("fixture.write", () => {
          attempts += 1
          if (attempts === 1) throw new DriverContention({ code: "ERR_SQLITE_ERROR", errcode })
          return "saved"
        }, (cause) => new OtherSqliteFailure({ cause }))))
        yield* TestClock.adjust(1_000)
        expect(yield* Fiber.join(pending)).toEqual(Result.succeed("saved"))
        expect(attempts).toBe(2)
      })
  )

  it.effect("does not retry a non-contention SQLite failure", () =>
    Effect.gen(function*() {
      let attempts = 0
      const result = yield* Effect.result(connectSqliteWrite("fixture.write", () => {
        attempts += 1
        throw new DriverContention({ code: "ERR_SQLITE_ERROR", errcode: 19 })
      }, (cause) => new OtherSqliteFailure({ cause })))
      expect(result).toMatchObject({ failure: { _tag: "OtherSqliteFailure" } })
      expect(attempts).toBe(1)
    }))
})
