import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Ref } from "effect"
import { updatePortOnConflict } from "../src/server/internal/PortRetry.js"

const portTaken = new Error("listen EADDRINUSE: address already in use, port 3000")

/** One bind attempt per run: it dies with `defect` and records that it ran. */
const attempt = (attempts: Ref.Ref<number>, listening: Ref.Ref<boolean>, listenFirst: boolean, defect: Error) =>
  Effect.gen(function*() {
    yield* Ref.update(attempts, (n) => n + 1)
    if (listenFirst) yield* Ref.set(listening, true)
    return yield* Effect.die(defect)
  })

describe("updatePortOnConflict", () => {
  it.effect("moves to the next port when a bind fails before the server is listening", () =>
    Effect.gen(function*() {
      const port = yield* Ref.make(3000)
      const retries = yield* Ref.make(10)
      const listening = yield* Ref.make(false)
      const attempts = yield* Ref.make(0)
      yield* attempt(attempts, listening, false, portTaken).pipe(updatePortOnConflict(port, retries, listening))
      expect(yield* Ref.get(port)).toBe(3001)
      expect(yield* Ref.get(attempts)).toBe(1)
    }))

  it.effect("surfaces a failure once the server is listening, even one that mentions a port", () =>
    Effect.gen(function*() {
      const port = yield* Ref.make(3000)
      const retries = yield* Ref.make(10)
      const listening = yield* Ref.make(false)
      const attempts = yield* Ref.make(0)
      const exit = yield* Effect.exit(
        attempt(attempts, listening, true, portTaken).pipe(updatePortOnConflict(port, retries, listening))
      )
      expect(Exit.hasDies(exit)).toBe(true)
      expect(yield* Ref.get(port)).toBe(3000)
    }))
})
