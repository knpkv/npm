import { describe, expect, it } from "@effect/vitest"
import { HubPaths } from "@knpkv/herdr-fleet"
import { ConfigProvider, Effect } from "effect"
import { fleetConfigPath, fleetConfigSource } from "../src/internal/config-path.js"
import { ownerTable } from "./fixtures/hub-paths.js"

// Each case owns its environment and its computer's path table.
const withEnv = (values: Readonly<Record<string, string>>) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(HubPaths, ownerTable()),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values))
  )

describe("fleet configuration path", () => {
  it.effect("reads the computer's default only when the explicit path is absent", () =>
    Effect.gen(function*() {
      expect(yield* fleetConfigPath.pipe(withEnv({ FLEET_CONFIG_PATH: "/explicit/config.json" })))
        .toBe("/explicit/config.json")
      expect(yield* fleetConfigPath.pipe(withEnv({}))).toBe("/home/owner/.config/fleet/config.json")
    }))

  // Only the default location may fall back to standalone; an explicit path never does.
  it.effect("says whether the path was named explicitly", () =>
    Effect.gen(function*() {
      expect(yield* fleetConfigSource.pipe(withEnv({ FLEET_CONFIG_PATH: "/explicit/config.json" }))).toEqual({
        path: "/explicit/config.json",
        explicit: true
      })
      expect(yield* fleetConfigSource.pipe(withEnv({}))).toEqual({
        path: "/home/owner/.config/fleet/config.json",
        explicit: false
      })
    }))
})
