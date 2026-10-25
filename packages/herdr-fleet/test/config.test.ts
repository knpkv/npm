import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { loadConfiguration, loadConfigurationOrStandalone, standaloneDefaults } from "../src/config.js"
import { HostConfiguration } from "../src/model.js"
import { HubPaths, type HubPathsInput, hubPathTable } from "../src/paths.js"

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
  // Each case owns its computer: a path table from fixtures, never the runner's HOME.
  const withPaths = (input: Partial<HubPathsInput> = {}) =>
    Effect.provideService(
      HubPaths,
      hubPathTable({ windows: false, home: "/home/owner", hostname: "atlas", env: {}, ...input })
    )

  it.layer(NodeServices.layer)((it) => {
    // No file is a first run on a computer outside any fleet: run as its own local hub.
    it.effect("runs standalone, schema-valid, when the file is missing", () =>
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fleet-standalone-" })
        const file = path.join(directory, "config.json")
        const loaded = yield* loadConfigurationOrStandalone(file).pipe(
          withPaths()
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

    // A fleet host runs agents under the owner's login, so it is never where the owner approves: a node
    // listed as both would silently lose approving once hosts are told apart, so the file is refused.
    it.effect("refuses a node that is both a fleet machine and an approval node", () =>
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fleet-overlap-" })
        const { config } = yield* loadConfigurationOrStandalone(path.join(directory, "config.json")).pipe(withPaths())
        expect(Schema.decodeUnknownResult(HostConfiguration)({ ...config, approvalNodes: ["node-phone"] })._tag)
          .toBe("Success")
        const overlapping = Schema.decodeUnknownResult(HostConfiguration)({ ...config, approvalNodes: ["local"] })
        expect(overlapping._tag).toBe("Failure")
        expect(String(overlapping)).toContain("no node that is both a fleet machine and an approval node")
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
            withPaths(),
            Effect.flip
          )
          expect(error._tag).toBe("FleetValidationError")
        }
      }).pipe(Effect.scoped))

    // On a case-insensitive volume the listing can spell the entry `Config.json` while `config.json`
    // still opens it: that file is the operator's, never a reason to run standalone.
    it.effect("reads a file the listing spells in another case", () =>
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fleet-case-" })
        const file = path.join(directory, "config.json")
        const standalone = yield* standaloneDefaults.pipe(withPaths())
        yield* fileSystem.writeFileString(file, JSON.stringify({ ...standalone, host: "atlas", repository: "/repo" }))
        const caseInsensitive = FileSystem.FileSystem.of({
          ...fileSystem,
          readDirectory: (target, options) =>
            fileSystem.readDirectory(target, options).pipe(
              Effect.map((names) => names.map((name) => name === "config.json" ? "Config.json" : name))
            )
        })
        const loaded = yield* loadConfigurationOrStandalone(file).pipe(
          withPaths(),
          Effect.provideService(FileSystem.FileSystem, caseInsensitive)
        )
        expect(loaded._tag).toBe("File")
        expect(loaded.config.repository).toBe("/repo")
      }).pipe(Effect.scoped))

    it.effect("reads an existing file as before", () =>
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fleet-standalone-" })
        const file = path.join(directory, "config.json")
        const standalone = yield* standaloneDefaults.pipe(withPaths())
        yield* fileSystem.writeFileString(file, JSON.stringify({ ...standalone, host: "atlas", repository: "/repo" }))
        const loaded = yield* loadConfigurationOrStandalone(file).pipe(withPaths())
        expect(loaded._tag).toBe("File")
        expect(loaded.config.repository).toBe("/repo")
      }).pipe(Effect.scoped))
  })

  it.layer(NodeServices.layer)((it) => {
    // An explicitly named file is the operator's: missing means not written yet, never "run standalone".
    it.effect("keeps failing when an explicitly configured path has no file", () =>
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fleet-explicit-" })
        const file = path.join(directory, "config.json")
        const error = yield* loadConfigurationOrStandalone(file, { standaloneWhenMissing: false }).pipe(
          withPaths(),
          Effect.flip
        )
        expect(error).toMatchObject({
          _tag: "FleetValidationError",
          detail: `no fleet configuration at ${file}; create it, or set FLEET_CONFIG_PATH to an existing file`
        })
      }).pipe(Effect.scoped))

    // A managed configuration is often a symlink that a switch briefly leaves dangling: fail and retry,
    // never come up as a hub without the fleet.
    it.effect("fails on a dangling symlink at the default path", () =>
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fleet-dangling-" })
        const file = path.join(directory, "config.json")
        const target = path.join(directory, "generation", "config.json")
        yield* fileSystem.symlink(target, file)
        const error = yield* loadConfigurationOrStandalone(file).pipe(
          withPaths(),
          Effect.flip
        )
        expect(error).toMatchObject({
          _tag: "FleetValidationError",
          detail: expect.stringContaining(`${file} exists but does not resolve`)
        })
      }).pipe(Effect.scoped))

    // Present but unreadable is the operator's entry too. A directory stays unreadable as a file even
    // for root, unlike a mode-000 file, so this holds on any runner.
    it.effect("fails on an entry it cannot read instead of running standalone", () =>
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fleet-unreadable-" })
        const file = path.join(directory, "config.json")
        yield* fileSystem.makeDirectory(file)
        const error = yield* loadConfigurationOrStandalone(file).pipe(
          withPaths(),
          Effect.flip
        )
        expect(error._tag).toBe("FleetValidationError")
      }).pipe(Effect.scoped))
  })

  it.effect("derives the state directory from XDG_STATE_HOME, else the home directory", () =>
    Effect.gen(function*() {
      expect((yield* standaloneDefaults.pipe(withPaths({ env: { XDG_STATE_HOME: "/state" } }))).stateDirectory)
        .toBe("/state/fleet")
      expect((yield* standaloneDefaults.pipe(withPaths())).stateDirectory).toBe("/home/owner/.local/state/fleet")
      expect((yield* standaloneDefaults.pipe(withPaths())).repository).toBe("/home/owner")
    }))

  // A container's hostname may hold characters a fleet host name refuses; an empty one falls back.
  it.effect("names the host from the computer's host name as a valid fleet host name", () =>
    Effect.gen(function*() {
      const host = (hostname: string) =>
        standaloneDefaults.pipe(withPaths({ hostname }), Effect.map((config) => config.host))
      expect(yield* host("build_box.local")).toBe("build-box.local")
      expect(yield* host("-_-")).toBe("localhost")
      expect(yield* host("")).toBe("localhost")
    }))

  // Windows has no HOME and no XDG layout: a standalone hub keeps its state under %LOCALAPPDATA%.
  it.effect("keeps a Windows standalone host's state under LOCALAPPDATA", () =>
    Effect.gen(function*() {
      const config = yield* standaloneDefaults.pipe(withPaths({
        windows: true,
        home: "C:\\Users\\owner",
        hostname: "DESKTOP-1",
        env: { LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local" }
      }))
      expect(config).toMatchObject({
        host: "DESKTOP-1",
        repository: "C:\\Users\\owner",
        stateDirectory: "C:\\Users\\owner\\AppData\\Local\\fleet"
      })
    }))
})
