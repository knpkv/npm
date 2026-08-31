import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Result } from "effect"
import { fleetConfigPath } from "../src/internal/config-path.js"

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
      expect(yield* loadWith({ HOME: "/home/andrey" })).toBe(
        "/home/andrey/.config/fleet/config.json"
      )
      expect(Result.isFailure(yield* Effect.result(loadWith({})))).toBe(true)
    }))
})
