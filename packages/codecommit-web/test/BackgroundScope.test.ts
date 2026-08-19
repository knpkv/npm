import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect } from "effect"
import { BackgroundScope, BackgroundScopeLive } from "../src/server/internal/BackgroundScope.js"

describe("BackgroundScope", () => {
  it.effect("interrupts server workers when the handler layer closes", () => {
    const started = Deferred.makeUnsafe<void>()
    const finalized = Deferred.makeUnsafe<void>()

    return Effect.gen(function*() {
      yield* Effect.scoped(
        Effect.gen(function*() {
          const ownerScope = yield* BackgroundScope
          yield* Effect.forkIn(
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(finalized, undefined))
            ),
            ownerScope
          )
          yield* Deferred.await(started)
        }).pipe(Effect.provide(BackgroundScopeLive))
      )

      yield* Deferred.await(finalized)
      expect(true).toBe(true)
    })
  })
})
