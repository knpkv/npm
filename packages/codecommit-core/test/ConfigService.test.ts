import { FileSystem, Path } from "@effect/platform"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { ConfigService, ConfigServiceLive } from "../src/ConfigService/index.js"

/**
 * ConfigService tests use mocked FileSystem to avoid touching real disk.
 * Tests verify config load/save lifecycle and auto-detection fallback.
 */

const MockPath = Path.layer

const makeMockFS = (files: Record<string, string>) =>
  Layer.succeed(
    FileSystem.FileSystem,
    FileSystem.FileSystem.of({
      exists: (path) => Effect.succeed(path in files),
      readFileString: (path) =>
        path in files
          ? Effect.succeed(files[path]!)
          : Effect.fail({ _tag: "SystemError", reason: "NotFound" } as any),
      writeFileString: () => Effect.void,
      makeDirectory: () => Effect.void
    } as any)
  )

const makeTestLayer = (files: Record<string, string>) =>
  ConfigServiceLive.pipe(Layer.provide(Layer.merge(makeMockFS(files), MockPath)))

describe("ConfigService", () => {
  // When no config file exists and no AWS profiles, should return empty accounts
  it.layer(makeTestLayer({}))("empty config when no file exists", (it) => {
    it.effect("returns empty accounts with autoDetect", () =>
      Effect.gen(function*() {
        const service = yield* ConfigService
        const config = yield* service.load
        expect(config.accounts).toEqual([])
        expect(config.autoDetect).toBe(true)
      }))
  })

  // Valid JSON config must be parsed and return correct account data
  it.layer(makeTestLayer({
    [`${process.env.HOME}/.codecommit/config.json`]: JSON.stringify({
      accounts: [
        { profile: "work", regions: ["us-west-2"], enabled: true },
        { profile: "personal", regions: ["eu-west-1"], enabled: false }
      ]
    })
  }))("loads valid config", (it) => {
    it.effect("parses accounts from JSON file", () =>
      Effect.gen(function*() {
        const service = yield* ConfigService
        const config = yield* service.load
        expect(config.accounts).toHaveLength(2)
        expect(config.accounts[0]!.profile).toBe("work")
        expect(config.accounts[0]!.enabled).toBe(true)
        expect(config.accounts[1]!.profile).toBe("personal")
        expect(config.accounts[1]!.enabled).toBe(false)
      }))
  })

  // Config with missing optional fields must apply Schema defaults
  it.layer(makeTestLayer({
    [`${process.env.HOME}/.codecommit/config.json`]: JSON.stringify({
      accounts: [{ profile: "minimal" }]
    })
  }))("applies defaults for missing fields", (it) => {
    it.effect("defaults regions to [us-east-1] and enabled to true", () =>
      Effect.gen(function*() {
        const service = yield* ConfigService
        const config = yield* service.load
        expect(config.accounts[0]!.regions).toEqual(["us-east-1"])
        expect(config.accounts[0]!.enabled).toBe(true)
        expect(config.autoDetect).toBe(true)
      }))
  })
})
