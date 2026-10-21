import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Result } from "effect"
import { fleetConfigPath, fleetConfigSource } from "../src/internal/config-path.js"

const loadWith = (values: Readonly<Record<string, string>>) =>
  fleetConfigPath.pipe(
    // This test boundary owns the isolated configuration provider.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown(values))
    )
  )

describe("fleet configuration path", () => {
  it.effect("reads HOME only when the explicit path is absent", () =>
    Effect.gen(function*() {
      expect(
        yield* loadWith({ FLEET_CONFIG_PATH: "/explicit/config.json" })
      ).toBe("/explicit/config.json")
      expect(yield* loadWith({ HOME: "/home/owner" })).toBe(
        "/home/owner/.config/fleet/config.json"
      )
      expect(Result.isFailure(yield* Effect.result(loadWith({})))).toBe(true)
    }))

  // Only the default location may fall back to standalone; an explicit path never does.
  it.effect("says whether the path was named explicitly", () =>
    Effect.gen(function*() {
      const source = (values: Readonly<Record<string, string>>) =>
        fleetConfigSource.pipe(
          // This test boundary owns the isolated configuration provider.
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values))
        )
      expect(yield* source({ FLEET_CONFIG_PATH: "/explicit/config.json", HOME: "/home/owner" })).toEqual({
        path: "/explicit/config.json",
        explicit: true
      })
      expect(yield* source({ HOME: "/home/owner" })).toEqual({
        path: "/home/owner/.config/fleet/config.json",
        explicit: false
      })
    }))
})
