import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Path, Schema } from "effect"
import { loadConfiguration, loadConfigurationOrStandalone, standaloneDefaults } from "../src/config.js"
import { HostConfiguration } from "../src/model.js"

describe("fleet configuration", () => {
  it.layer(NodeServices.layer)((it) => {
    // A first run has no configuration file: the error says where it was looked for and what to do,
    // in one line, instead of a platform error dump.
    it.effect("names the missing file and the fix when there is no configuration", () =>
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        // Removed when the test's scope closes, whether or not the assertion passes.
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fleet-config-" })
        const file = path.join(directory, "config.json")
        const error = yield* loadConfiguration(file).pipe(Effect.flip)
        expect(error.detail).toBe(
          `no fleet configuration at ${file}; create it, or set FLEET_CONFIG_PATH to an existing file`
        )
      }).pipe(Effect.scoped))
  })
})

it("keeps heavy gate configuration absent by default and requires an explicit absolute directory", () => {
  const configuration = Schema.Struct({ heavyGate: HostConfiguration.fields.heavyGate })
  expect(Schema.decodeUnknownSync(configuration)({})).toEqual({})
  expect(Schema.decodeUnknownSync(configuration)({ heavyGate: { lockDirectory: "/run/heavy-gate" } })).toEqual({
    heavyGate: { lockDirectory: "/run/heavy-gate" }
  })
  for (const lockDirectory of ["", "relative/path"]) {
    expect(Schema.decodeUnknownResult(configuration)({ heavyGate: { lockDirectory } })._tag).toBe("Failure")
  }
})

describe("standalone fallback", () => {
  // Each case owns its isolated environment.
  const withEnv = (values: Readonly<Record<string, string>>) =>
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values))

  it.layer(NodeServices.layer)((it) => {
    // No file is a first run on a computer outside any fleet: run as its own local hub.
    it.effect("runs standalone, schema-valid, when the file is missing", () =>
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fleet-standalone-" })
        const file = path.join(directory, "config.json")
        const loaded = yield* loadConfigurationOrStandalone(file).pipe(
          withEnv({ HOME: "/home/owner", HOSTNAME: "atlas" })
        )
        expect(loaded._tag).toBe("Standalone")
        expect(loaded.path).toBe(file)
        expect(Schema.decodeUnknownResult(HostConfiguration)(loaded.config)._tag).toBe("Success")
        expect(loaded.config).toMatchObject({
          host: "atlas",
          crossHost: false,
          localPort: 4778,
          port: 4777,
          stateDirectory: "/home/owner/.local/state/fleet",
          machines: [{ host: "atlas", nodeId: "local" }],
          allowedUsers: [],
          approvalTls: null
        })
      }).pipe(Effect.scoped))

    // A file that exists is the operator's: never replace it, even when it is wrong.
    it.effect("still fails on a malformed or invalid file", () =>
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fleet-standalone-" })
        const file = path.join(directory, "config.json")
        for (const text of ["{not json", "{}"]) {
          yield* fileSystem.writeFileString(file, text)
          const error = yield* loadConfigurationOrStandalone(file).pipe(
            withEnv({ HOME: "/home/owner" }),
            Effect.flip
          )
          expect(error._tag).toBe("FleetValidationError")
        }
      }).pipe(Effect.scoped))

    it.effect("reads an existing file as before", () =>
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fleet-standalone-" })
        const file = path.join(directory, "config.json")
        const standalone = yield* standaloneDefaults.pipe(withEnv({ HOME: "/home/owner", HOSTNAME: "atlas" }))
        yield* fileSystem.writeFileString(file, JSON.stringify({ ...standalone, host: "atlas", repository: "/repo" }))
        const loaded = yield* loadConfigurationOrStandalone(file).pipe(withEnv({ HOME: "/home/owner" }))
        expect(loaded._tag).toBe("File")
        expect(loaded.config.repository).toBe("/repo")
      }).pipe(Effect.scoped))
  })

  it.effect("derives the state directory from XDG_STATE_HOME, else HOME", () =>
    Effect.gen(function*() {
      expect(
        (yield* standaloneDefaults.pipe(withEnv({ HOME: "/home/owner", XDG_STATE_HOME: "/state" })))
          .stateDirectory
      ).toBe("/state/fleet")
      expect((yield* standaloneDefaults.pipe(withEnv({ HOME: "/home/owner" }))).stateDirectory)
        .toBe("/home/owner/.local/state/fleet")
    }))

  // A container's hostname may hold characters a fleet host name refuses; an empty one falls back.
  it.effect("names the host from HOSTNAME as a valid fleet host name", () =>
    Effect.gen(function*() {
      const host = (values: Readonly<Record<string, string>>) =>
        standaloneDefaults.pipe(withEnv({ HOME: "/home/owner", ...values }), Effect.map((config) => config.host))
      expect(yield* host({ HOSTNAME: "build_box.local" })).toBe("build-box.local")
      expect(yield* host({ HOSTNAME: "-_-" })).toBe("localhost")
      expect(yield* host({})).toBe("localhost")
    }))
})
