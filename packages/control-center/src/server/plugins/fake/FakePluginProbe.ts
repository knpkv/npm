import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"

/** Redacted deterministic call captured by the fake adapter. */
export interface FakePluginCall {
  readonly operation: string
  readonly key: string | null
}

/** Snapshot used by contract tests without exposing mutable fake state. */
export interface FakePluginProbeSnapshot {
  readonly calls: ReadonlyArray<FakePluginCall>
  readonly providerMutations: number
  readonly runtimeAcquisitions: number
  readonly runtimeReleases: number
}

/** Test observer for calls, exact-once mutations, and scoped runtime lifecycle. */
export interface FakePluginProbe {
  readonly snapshot: Effect.Effect<FakePluginProbeSnapshot>
}

export interface FakePluginProbeControl {
  readonly probe: FakePluginProbe
  readonly recordCall: (operation: string, key?: string | undefined) => Effect.Effect<void>
  readonly recordMutation: Effect.Effect<void>
  readonly recordAcquisition: Effect.Effect<void>
  readonly recordRelease: Effect.Effect<void>
}

/** Construct isolated probe state for one fake connection definition. */
export const makeFakePluginProbe = Effect.fn("FakePlugin.makeProbe")(function*() {
  const calls = yield* Ref.make<ReadonlyArray<FakePluginCall>>([])
  const providerMutations = yield* Ref.make(0)
  const runtimeAcquisitions = yield* Ref.make(0)
  const runtimeReleases = yield* Ref.make(0)

  return {
    probe: {
      snapshot: Effect.all({
        calls: Ref.get(calls),
        providerMutations: Ref.get(providerMutations),
        runtimeAcquisitions: Ref.get(runtimeAcquisitions),
        runtimeReleases: Ref.get(runtimeReleases)
      })
    },
    recordCall: (operation: string, key?: string | undefined) =>
      Ref.update(calls, (current) => [...current, { operation, key: key ?? null }]),
    recordMutation: Ref.update(providerMutations, (count) => count + 1),
    recordAcquisition: Ref.update(runtimeAcquisitions, (count) => count + 1),
    recordRelease: Ref.update(runtimeReleases, (count) => count + 1)
  } satisfies FakePluginProbeControl
})
