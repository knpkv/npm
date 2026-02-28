import { FileSystem, Path } from "@effect/platform"
import { SystemError } from "@effect/platform/Error"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { EventsHub } from "../src/CacheService/EventsHub.js"
import { ConfigService, ConfigServiceLive } from "../src/ConfigService/index.js"

const MockPath = Path.layer

const TEST_HOME = "/tmp/test-home"
const configPath = `${TEST_HOME}/.codecommit/config.json`

const fsError = (method: string) =>
  Effect.fail(
    new SystemError({ reason: "NotFound", module: "FileSystem", method, description: "mock not found" })
  )

const makeMockFS = (files: Record<string, string>) => {
  const store = { ...files }
  const partial: Partial<FileSystem.FileSystem> = {
    exists: (path) => Effect.succeed(path in store),
    readFileString: (path) => path in store ? Effect.succeed(store[path]!) : fsError("readFileString"),
    writeFileString: (path: string, content: string) => {
      store[path] = content
      return Effect.void
    },
    makeDirectory: () => Effect.void,
    copyFile: (from: string, to: string) => {
      if (!(from in store)) return fsError("copyFile")
      store[to] = store[from]!
      return Effect.void
    },
    rename: (from: string, to: string) => {
      if (!(from in store)) return fsError("rename")
      store[to] = store[from]!
      delete store[from]
      return Effect.void
    }
  }
  return {
    store,
    layer: Layer.succeed(FileSystem.FileSystem, FileSystem.FileSystem.of(partial as FileSystem.FileSystem))
  }
}

const ConfigProviderLive = Layer.setConfigProvider(
  ConfigProvider.fromMap(new Map([["HOME", TEST_HOME]]))
)

const makeTestLayer = (files: Record<string, string>) => {
  const mock = makeMockFS(files)
  return {
    store: mock.store,
    layer: ConfigServiceLive.pipe(
      Layer.provide(Layer.mergeAll(mock.layer, MockPath, EventsHub.Default)),
      Layer.provide(ConfigProviderLive)
    )
  }
}

const run = <A>(files: Record<string, string>, effect: Effect.Effect<A, unknown, ConfigService>) => {
  const { layer } = makeTestLayer(files)
  return Effect.runPromise(Effect.provide(effect, layer))
}

describe("ConfigService", () => {
  it("returns empty accounts when no file exists", () =>
    run(
      {},
      Effect.gen(function*() {
        const service = yield* ConfigService
        const config = yield* service.load
        expect(config.accounts).toEqual([])
        expect(config.autoDetect).toBe(true)
      })
    ))

  it("parses accounts from valid config file", () =>
    run(
      {
        [configPath]: JSON.stringify({
          accounts: [
            { profile: "work", regions: ["us-west-2"], enabled: true },
            { profile: "personal", regions: ["eu-west-1"], enabled: false }
          ]
        })
      },
      Effect.gen(function*() {
        const service = yield* ConfigService
        const config = yield* service.load
        expect(config.accounts).toHaveLength(2)
        expect(config.accounts[0]!.profile).toBe("work")
        expect(config.accounts[0]!.enabled).toBe(true)
        expect(config.accounts[1]!.profile).toBe("personal")
        expect(config.accounts[1]!.enabled).toBe(false)
      })
    ))

  it("applies defaults for missing optional fields", () =>
    run(
      {
        [configPath]: JSON.stringify({ accounts: [{ profile: "minimal" }] })
      },
      Effect.gen(function*() {
        const service = yield* ConfigService
        const config = yield* service.load
        expect(config.accounts[0]!.regions).toEqual(["us-east-1"])
        expect(config.accounts[0]!.enabled).toBe(true)
        expect(config.autoDetect).toBe(true)
      })
    ))

  it("getConfigPath returns resolved path", () =>
    run(
      {},
      Effect.gen(function*() {
        const service = yield* ConfigService
        const path = yield* service.getConfigPath
        expect(path).toBe(configPath)
      })
    ))

  it("validate returns missing when no file", () =>
    run(
      {},
      Effect.gen(function*() {
        const service = yield* ConfigService
        const result = yield* service.validate
        expect(result.status).toBe("missing")
        expect(result.path).toBe(configPath)
      })
    ))

  it("validate returns valid for correct config", () =>
    run(
      {
        [configPath]: JSON.stringify({ accounts: [{ profile: "test" }] })
      },
      Effect.gen(function*() {
        const service = yield* ConfigService
        const result = yield* service.validate
        expect(result.status).toBe("valid")
      })
    ))

  it("validate returns corrupted for malformed JSON", () =>
    run(
      {
        [configPath]: "not valid json {{"
      },
      Effect.gen(function*() {
        const service = yield* ConfigService
        const result = yield* service.validate
        expect(result.status).toBe("corrupted")
        expect(result.errors.length).toBeGreaterThan(0)
      })
    ))

  it("backup creates .bak and returns path", () => {
    const { layer, store } = makeTestLayer({
      [configPath]: JSON.stringify({ accounts: [] })
    })
    return Effect.runPromise(
      Effect.provide(
        Effect.gen(function*() {
          const service = yield* ConfigService
          const backupPath = yield* service.backup
          expect(backupPath).toBe(configPath + ".bak")
          expect(store[configPath + ".bak"]).toBeDefined()
        }),
        layer
      )
    )
  })

  it("backup fails when config does not exist", () =>
    run(
      {},
      Effect.gen(function*() {
        const service = yield* ConfigService
        const result = yield* service.backup.pipe(Effect.either)
        expect(result._tag).toBe("Left")
      })
    ))

  it("reset from scratch returns fresh config", () =>
    run(
      {},
      Effect.gen(function*() {
        const service = yield* ConfigService
        const config = yield* service.reset
        expect(config.autoDetect).toBe(true)
        expect(Array.isArray(config.accounts)).toBe(true)
      })
    ))

  it("reset with existing config backs up and regenerates", () => {
    const { layer, store } = makeTestLayer({
      [configPath]: JSON.stringify({ accounts: [{ profile: "old" }] })
    })
    return Effect.runPromise(
      Effect.provide(
        Effect.gen(function*() {
          const service = yield* ConfigService
          const config = yield* service.reset
          expect(config.autoDetect).toBe(true)
          expect(store[configPath + ".bak"]).toBeDefined()
          const validation = yield* service.validate
          expect(validation.status).toBe("valid")
        }),
        layer
      )
    )
  })
})
