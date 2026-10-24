import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, FileSystem, Predicate } from "effect"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import process from "node:process"
import { findNpmCli, makeNpm, type NpmViewVersion, resolvedFrom } from "../src/apps/npm.js"
import { isTrusted, trustLines } from "../src/apps/trust.js"

const windows = process.platform === "win32"

/** The npm this test run uses, found by the CLI's own rule. */
const npmCli = Effect.runPromise(
  findNpmCli({ execPath: process.execPath, windows, path: process.env.PATH ?? "" }).pipe(
    Effect.provide(NodeServices.layer)
  )
)

const fixtureVersion = (version: string, extra: Partial<NpmViewVersion> = {}): NpmViewVersion => ({
  name: "@knpkv/hub-app-fixture",
  version,
  time: { [version]: "2026-10-20T10:00:00.000Z" },
  maintainers: [{ name: "knpkv", email: "ops@example.test" }],
  dist: { integrity: `sha512-${version}`, tarball: `http://registry.test/fixture-${version}.tgz` },
  hubApp: { bin: "dist/bin.js", contract: 1, services: ["fleet.read"] },
  ...extra
})

/** A registry stand-in answering packument requests for one package. */
const registry = (versions: ReadonlyArray<NpmViewVersion>) =>
  Effect.acquireRelease(
    Effect.promise(() =>
      new Promise<{ server: Server; url: string; requests: Array<string> }>((resolve) => {
        const requests: Array<string> = []
        const server = createServer((request, response) => {
          requests.push(request.url ?? "")
          if (decodeURIComponent(request.url ?? "") !== "/@knpkv/hub-app-fixture") {
            response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }))
            return
          }
          const latest = versions.at(-1)?.version ?? "0.0.0"
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            name: "@knpkv/hub-app-fixture",
            "dist-tags": { latest },
            versions: Object.fromEntries(versions.map((version) => [version.version, version])),
            time: Object.fromEntries(versions.map((version) => [version.version, "2026-10-20T10:00:00.000Z"]))
          }))
        })
        server.listen(0, "127.0.0.1", () => {
          const address = server.address()
          const port = address === null || Predicate.isString(address) ? 0 : address.port
          resolve({ server, url: `http://127.0.0.1:${port}/`, requests })
        })
      })
    ),
    ({ server }) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())))
  )

/** npm in a throwaway directory whose only config is `npmrc`. */
const npmWith = (npmrc: string) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ directory: tmpdir(), prefix: "apps-npm-" })
    yield* fileSystem.writeFileString(`${cwd}/.npmrc`, npmrc)
    return yield* makeNpm({
      node: process.execPath,
      npmCli: yield* Effect.promise(() => npmCli),
      cwd,
      env: { npm_config_userconfig: `${cwd}/.npmrc`, npm_config_cache: `${cwd}/cache` }
    })
  })

describe("npm resolve", () => {
  it.effect("picks the newest version of a range and reads its trust facts", () =>
    Effect.gen(function*() {
      const resolved = yield* resolvedFrom("@knpkv/hub-app-fixture", [
        fixtureVersion("1.0.0"),
        fixtureVersion("1.2.0", { scripts: { postinstall: "node x.js", test: "vitest" } })
      ])
      expect(resolved).toEqual({
        package: "@knpkv/hub-app-fixture",
        version: "1.2.0",
        integrity: "sha512-1.2.0",
        hubApp: { bin: "dist/bin.js", contract: 1, services: ["fleet.read"] },
        publishedAt: "2026-10-20T10:00:00.000Z",
        maintainers: ["knpkv"],
        provenance: false,
        installScripts: ["postinstall"]
      })
    }))

  // npm view lists a range's matches in publish order, so a backport published after a newer release comes last.
  it.effect("picks the highest version by semver, not the last one npm listed", () =>
    Effect.gen(function*() {
      const backport = yield* resolvedFrom("@knpkv/hub-app-fixture", [
        fixtureVersion("1.0.0"),
        fixtureVersion("1.4.0"),
        fixtureVersion("1.2.1")
      ])
      const release = yield* resolvedFrom("@knpkv/hub-app-fixture", [
        fixtureVersion("1.4.0"),
        fixtureVersion("1.4.0-rc.1")
      ])
      const prerelease = yield* resolvedFrom("@knpkv/hub-app-fixture", [
        fixtureVersion("2.0.0-rc.10"),
        fixtureVersion("2.0.0-rc.9"),
        fixtureVersion("2.0.0-rc.beta")
      ])
      expect([backport.version, release.version, prerelease.version]).toEqual(["1.4.0", "1.4.0", "2.0.0-rc.beta"])
    }))

  // A typo (`left-pad` as an app) or a package with a malformed field is refused before any download.
  it.effect("refuses a package without a valid hubApp field", () =>
    Effect.gen(function*() {
      const missing = yield* resolvedFrom("left-pad", {
        ...fixtureVersion("1.0.0"),
        name: "left-pad",
        hubApp: undefined
      })
        .pipe(Effect.flip)
      const malformed = yield* resolvedFrom("@knpkv/x", fixtureVersion("1.0.0", { hubApp: { bin: "", contract: 1 } }))
        .pipe(Effect.flip)
      expect([missing._tag, malformed._tag]).toEqual(["NotAHubApp", "NotAHubApp"])
    }))

  it.layer(NodeServices.layer, { excludeTestServices: true })((it) => {
    // nix's nodejs-slim keeps npm out of node's own directory and links npm-cli.js onto PATH; that link is npm.
    it.effect.skipIf(windows)("takes the npm on PATH when it is a link to npm-cli.js", () =>
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const root = yield* fileSystem.makeTempDirectoryScoped({ directory: tmpdir(), prefix: "apps-npm-path-" })
        const real = `${root}/store/lib/node_modules/npm/bin/npm-cli.js`
        yield* fileSystem.makeDirectory(`${root}/store/lib/node_modules/npm/bin`, { recursive: true })
        yield* fileSystem.writeFileString(real, "")
        yield* fileSystem.makeDirectory(`${root}/bin`)
        yield* fileSystem.symlink(real, `${root}/bin/npm`)
        const found = yield* findNpmCli({
          execPath: `${root}/node/bin/node`,
          windows,
          path: `${root}/empty:${root}/bin`
        })
        expect(found).toBe(yield* fileSystem.realPath(real))
      }).pipe(Effect.scoped))

    // A wrapper script (a version-manager shim) could run any npm, or none; only npm's own entry script is run.
    it.effect.skipIf(windows)(
      "refuses an npm on PATH that is a script, naming both places it looked",
      () =>
        Effect.gen(function*() {
          const fileSystem = yield* FileSystem.FileSystem
          const root = yield* fileSystem.makeTempDirectoryScoped({ directory: tmpdir(), prefix: "apps-npm-path-" })
          yield* fileSystem.makeDirectory(`${root}/bin`)
          yield* fileSystem.writeFileString(`${root}/bin/npm`, "#!/bin/sh\nexec some-npm \"$@\"\n")
          const error = yield* findNpmCli({ execPath: `${root}/node/bin/node`, windows, path: `${root}/bin` })
            .pipe(Effect.flip)
          expect(error.looked).toEqual([
            `${root}/node/lib/node_modules/npm/bin/npm-cli.js`,
            `${root}/bin/npm (not npm-cli.js)`
          ])
          expect(error.message).toContain("Install a Node that ships npm (nodejs.org, mise) or put npm on PATH")
        }).pipe(Effect.scoped)
    )

    // The prompt must describe what the user's npm would install, so the registry comes from .npmrc.
    it.effect("resolves through the scoped registry .npmrc names", () =>
      Effect.gen(function*() {
        const scoped = yield* registry([fixtureVersion("1.0.0"), fixtureVersion("1.4.0")])
        const npm = yield* npmWith(`registry=http://127.0.0.1:9/\n@knpkv:registry=${scoped.url}\n`)
        const resolved = yield* npm.resolve("@knpkv/hub-app-fixture", "^1.0.0")
        expect(resolved.version).toBe("1.4.0")
        expect(resolved.integrity).toBe("sha512-1.4.0")
        expect(scoped.requests.length).toBeGreaterThan(0)
      }).pipe(Effect.scoped), 30_000)

    it.effect(
      "resolves a range to its highest version when the registry lists a backport last",
      () =>
        Effect.gen(function*() {
          const scoped = yield* registry([fixtureVersion("1.0.0"), fixtureVersion("1.4.0"), fixtureVersion("1.2.1")])
          const npm = yield* npmWith(`registry=${scoped.url}\n`)
          expect((yield* npm.resolve("@knpkv/hub-app-fixture", "^1.0.0")).version).toBe("1.4.0")
        }).pipe(Effect.scoped),
      30_000
    )

    // A registry that accepts and then never answers must not leave `apps add` hanging.
    it.effect("gives up on npm view after its timeout and says so", () =>
      Effect.gen(function*() {
        const stalled = yield* Effect.acquireRelease(
          Effect.callback<{ server: Server; url: string }>((resume) => {
            const server = createServer(() => {})
            server.once("error", (error) => resume(Effect.die(error)))
            server.listen(0, "127.0.0.1", () => {
              const address = server.address()
              const port = address === null || Predicate.isString(address) ? 0 : address.port
              resume(Effect.succeed({ server, url: `http://127.0.0.1:${port}/` }))
            })
          }),
          ({ server }) =>
            Effect.callback<void>((resume) => {
              server.closeAllConnections()
              server.close(() => resume(Effect.void))
            })
        )
        const fileSystem = yield* FileSystem.FileSystem
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ directory: tmpdir(), prefix: "apps-npm-" })
        yield* fileSystem.writeFileString(`${cwd}/.npmrc`, `registry=${stalled.url}\nfetch-retries=0\n`)
        const npm = yield* makeNpm({
          node: process.execPath,
          npmCli: yield* Effect.promise(() => npmCli),
          cwd,
          env: { npm_config_userconfig: `${cwd}/.npmrc`, npm_config_cache: `${cwd}/cache` },
          viewTimeout: Duration.seconds(2)
        })
        const error = yield* npm.resolve("@knpkv/hub-app-fixture", "latest").pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "AppInstallFailed", stage: "resolve", detail: "npm view timed out" })
      }).pipe(Effect.scoped), 30_000)

    it.effect("fails resolve with npm's own reason when the package does not exist", () =>
      Effect.gen(function*() {
        const scoped = yield* registry([])
        const npm = yield* npmWith(`registry=${scoped.url}\n`)
        const error = yield* npm.resolve("@knpkv/absent", "latest").pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "AppInstallFailed", stage: "resolve" })
        expect(error._tag === "AppInstallFailed" && error.detail).toContain("E404")
      }).pipe(Effect.scoped), 30_000)
  })
})

describe("trust", () => {
  it("covers a scope's packages and exact names, nothing else", () => {
    const scopes = ["@knpkv", "lone-app"]
    expect(
      ["@knpkv/herdr-usage", "lone-app", "@knpkv-evil/x", "lone-app-2", "@other/x"].map((name) =>
        isTrusted(scopes, name)
      )
    ).toEqual([true, true, false, false, false])
  })

  it("says what the app may do through the hub and that it runs as the user", () =>
    Effect.gen(function*() {
      const resolved = yield* resolvedFrom("@knpkv/hub-app-fixture", fixtureVersion("1.0.0"))
      expect(trustLines(resolved, "registry_has_no_signatures")).toEqual([
        "@knpkv/hub-app-fixture@1.0.0, published 2026-10-20T10:00:00.000Z",
        "Maintainers: knpkv",
        "Provenance: none",
        "Install scripts: none declared",
        "Registry signatures: this registry has none",
        "Hub access: reads the state of every fleet host",
        "This app runs as you, with access to your files."
      ])
    }).pipe(Effect.runSync))
})
