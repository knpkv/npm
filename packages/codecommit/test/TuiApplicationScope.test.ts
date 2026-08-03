import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Layer } from "effect"
import * as Atom from "effect/unstable/reactivity/Atom"
import {
  makeTuiApplicationRegistry,
  TuiApplicationScope,
  tuiApplicationScopeLayer
} from "../src/tui/atoms/applicationScope.js"

describe("TUI application scope", () => {
  it.effect("keeps an action worker through rerender and finalizes it with the program scope", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const finalized = yield* Deferred.make<void>()
      const actionRuntime = Atom.context({ memoMap: Layer.makeMemoMapUnsafe() })(
        (get) => tuiApplicationScopeLayer(get)
      )
      const action = actionRuntime.fn(() =>
        Effect.gen(function*() {
          const applicationScope = yield* TuiApplicationScope
          yield* Effect.forkIn(
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(finalized, undefined))
            ),
            applicationScope
          )
        })
      )

      yield* Effect.scoped(
        Effect.gen(function*() {
          const applicationScope = yield* Effect.scope
          const registry = yield* Effect.acquireRelease(
            Effect.sync(() => makeTuiApplicationRegistry(applicationScope)),
            (registry) => Effect.sync(() => registry.dispose())
          )

          let unmountRender = registry.mount(action)
          yield* Effect.addFinalizer(() => Effect.sync(() => unmountRender()))
          registry.set(action, undefined)
          yield* Deferred.await(started)

          unmountRender()
          unmountRender = registry.mount(action)
          expect(yield* Deferred.isDone(finalized)).toBe(false)
        })
      )

      yield* Deferred.await(finalized)
    }))
})
