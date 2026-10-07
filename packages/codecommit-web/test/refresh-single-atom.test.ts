import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Layer } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import * as Atom from "effect/reactivity/Atom"
import * as AtomRegistry from "effect/reactivity/AtomRegistry"
import { perKeyFn, refreshSinglePrAtom } from "../src/client/atoms/app.js"

describe("refreshSinglePrAtom", () => {
  // `ApiClient.mutation` hands every caller of an endpoint the same atom, so wrapping it in a family
  // keyed by route shared one mutation across all pull requests.
  it("is a separate atom for each pull-request route", () => {
    expect(refreshSinglePrAtom("dev/44")).not.toBe(refreshSinglePrAtom("dev/45"))
    expect(refreshSinglePrAtom("dev/44")).toBe(refreshSinglePrAtom("dev/44"))
  })
})

describe("perKeyFn", () => {
  it.effect("lets a call for one key finish while another key's call starts", () =>
    Effect.gen(function*() {
      const finishA = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const family = perKeyFn(Atom.runtime(Layer.empty), (id: string) =>
        id === "a" ? Deferred.await(finishA).pipe(Effect.as("a done")) : Deferred.succeed(started, undefined).pipe(
          Effect.as("b done")
        ))
      const registry = AtomRegistry.make()
      const unmountA = registry.mount(family("a"))
      const unmountB = registry.mount(family("b"))
      registry.set(family("a"), "a")
      registry.set(family("b"), "b")
      yield* Deferred.await(started)
      yield* Deferred.succeed(finishA, undefined)
      const a = yield* Effect.exit(AtomRegistry.getResult(registry, family("a"), { suspendOnWaiting: true }))
      expect(a).toEqual(Exit.succeed("a done"))
      expect(AsyncResult.isSuccess(registry.get(family("b")))).toBe(true)
      unmountA()
      unmountB()
    }))
})
