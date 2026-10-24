import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { AppId } from "@knpkv/hub-app"
import { Duration, Effect, FileSystem, PlatformError, Ref } from "effect"
import { tmpdir, userInfo } from "node:os"
import process from "node:process"
import { makeInstaller } from "../src/apps/installer.js"
import { findNpmCli, makeNpm } from "../src/apps/npm.js"
import { emptyAppsConfig, makeAppsStore } from "../src/apps/store.js"
import { prepareEndpointPlace } from "../src/apps/supervisor.js"
import { type FakeApp, packFakeApp, type Registry, startRegistry, type TestNpm } from "./fixtures/npm-registry.js"

const windows = process.platform === "win32"
const name = "@knpkv/fake-app"

/** npm, found by the CLI's own rule (a few stats; run inside each test's layer). */
const testNpm = findNpmCli({ execPath: process.execPath, windows, path: process.env.PATH ?? "" }).pipe(
  Effect.map((npmCli): TestNpm => ({ node: process.execPath, npmCli }))
)
const pack = (app: FakeApp) => Effect.flatMap(testNpm, (npm) => packFakeApp(npm, app))

const tempRoot = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  // Short: socket paths are limited to about 104 bytes.
  return yield* fileSystem.makeTempDirectoryScoped({ directory: tmpdir(), prefix: "inst-" })
})

/** Packs `app` and publishes it on `registry`. */
const publish = (registry: Registry, app: FakeApp) =>
  Effect.gen(function*() {
    const packed = yield* pack(app)
    registry.publish(app.name, app.version, packed, {
      bin: app.bin ?? "bin.js",
      contract: app.contract ?? 1,
      services: app.declared ?? app.services ?? []
    })
    return packed
  })

interface Overrides {
  /** Answers the trust prompt; may act between the view and the install. */
  readonly confirm?: Effect.Effect<boolean>
  readonly coreModuleIds?: ReadonlyArray<string>
  readonly auditTimeout?: Duration.Duration
  /** The installer's filesystem (to make one step fail). */
  readonly fileSystem?: (real: FileSystem.FileSystem) => FileSystem.FileSystem
}

/** An installer over `root`, with npm pointed at `registry`; `said` collects notices, `events` the remove steps. */
const installerIn = (root: string, registry: Registry, overrides: Overrides = {}) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    yield* fileSystem.makeDirectory(`${root}/npm`, { recursive: true })
    // The user's config only, outside npm's cwd, as the CLI has it: view and install must both read it. No retries:
    // a corrupt tarball fails at once instead of after npm's backoff.
    yield* fileSystem.writeFileString(`${root}/user.npmrc`, `registry=${registry.url}\nfetch-retries=0\n`)
    const npm = yield* makeNpm({
      node: process.execPath,
      npmCli: (yield* testNpm).npmCli,
      cwd: `${root}/npm`,
      env: { npm_config_userconfig: `${root}/user.npmrc`, npm_config_cache: `${root}/npm-cache` },
      auditTimeout: overrides.auditTimeout ?? Duration.seconds(60)
    })
    const store = yield* makeAppsStore({
      configPath: `${root}/config/apps.json`,
      lockPath: `${root}/data/hub-apps/.lock`,
      self: { pid: process.pid, host: "test" },
      processAlive: () => Effect.succeed(true)
    })
    const said = yield* Ref.make<ReadonlyArray<string>>([])
    const events = yield* Ref.make<ReadonlyArray<string>>([])
    const user = userInfo()
    const installer = yield* makeInstaller({
      store,
      npm,
      hubData: `${root}/data`,
      node: process.execPath,
      windows,
      coreModuleIds: overrides.coreModuleIds ?? ["fleet"],
      probePlace: prepareEndpointPlace({
        runtimeDirectory: windows ? null : `${root}/run`,
        shortRuntimeDirectory: `${root}/short`,
        user: { name: user.username, uid: user.uid }
      }),
      confirm: () => overrides.confirm ?? Effect.succeed(true),
      waitStopped: (id) =>
        fileSystem.exists(`${root}/data/hub-apps/${id}`).pipe(
          Effect.orDie,
          Effect.flatMap((present) =>
            Ref.update(events, (all) => [...all, `stopped ${id}, files ${present ? "present" : "gone"}`])
          )
        ),
      say: (line) => Ref.update(said, (lines) => [...lines, line])
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, overrides.fileSystem?.(fileSystem) ?? fileSystem)
    )
    return { installer, store, said, events }
  })

const appsJson = (root: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    fileSystem.readFileString(`${root}/config/apps.json`).pipe(
      Effect.catchTag("PlatformError", () => Effect.succeed("absent"))
    ))

/** What is in `<hubData>/hub-apps`, without the lock. */
const prefixes = (root: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    fileSystem.readDirectory(`${root}/data/hub-apps`).pipe(
      Effect.map((entries) => entries.filter((entry) => entry !== ".lock").sort()),
      Effect.catchTag("PlatformError", () => Effect.succeed([]))
    ))

describe("installer", () => {
  it.layer(NodeServices.layer, { excludeTestServices: true })((it) => {
    it.effect(
      "adds an app: installs, checks, probes, then commits it under its id and version",
      () =>
        Effect.gen(function*() {
          const root = yield* tempRoot
          const registry = yield* startRegistry
          yield* publish(registry, { name, version: "1.0.0", id: "fake" })
          const { installer, said, store } = yield* installerIn(root, registry)
          const entry = yield* installer.add(name, "latest", { allowScripts: false })
          expect(entry).toMatchObject({
            id: "fake",
            package: name,
            version: "1.0.0",
            dir: `${root}/data/hub-apps/fake/1.0.0`,
            bin: `node_modules/${name}/bin.js`,
            enabled: true,
            allowScripts: false
          })
          expect((yield* store.read).apps).toEqual([entry])
          expect(yield* prefixes(root)).toEqual(["fake"])
          expect(yield* Ref.get(said)).toEqual(["Registry signatures: this registry has none"])
        }).pipe(Effect.scoped),
      60_000
    )

    // What the user was shown must be what is installed; a registry can change its answer between the two.
    it.effect(
      "fails fetch, writing nothing, when the registry serves another tarball after the prompt",
      () =>
        Effect.gen(function*() {
          const root = yield* tempRoot
          const registry = yield* startRegistry
          yield* publish(registry, { name, version: "1.0.0", id: "fake" })
          const swapped = yield* pack({ name, version: "1.0.0", id: "fake", services: ["host"] })
          const { installer } = yield* installerIn(root, registry, {
            confirm: Effect.sync(() => {
              registry.publish(name, "1.0.0", swapped, { bin: "bin.js", contract: 1, services: ["host"] })
              return true
            })
          })
          const error = yield* installer.add(name, "latest", { allowScripts: false }).pipe(Effect.flip)
          expect(error).toMatchObject({ _tag: "AppInstallFailed", stage: "fetch" })
          expect(yield* appsJson(root)).toBe("absent")
          expect(yield* prefixes(root)).toEqual([])
        }).pipe(Effect.scoped),
      60_000
    )

    it.effect(
      "fails fetch on a corrupt tarball and leaves the installed apps as they were",
      () =>
        Effect.gen(function*() {
          const root = yield* tempRoot
          const registry = yield* startRegistry
          yield* publish(registry, { name, version: "1.0.0", id: "fake" })
          yield* publish(registry, { name: "@knpkv/other-app", version: "2.0.0", id: "other" })
          const { installer } = yield* installerIn(root, registry)
          yield* installer.add(name, "latest", { allowScripts: false })
          const before = yield* appsJson(root)
          registry.corrupt("@knpkv/other-app", "2.0.0")
          const error = yield* installer.add("@knpkv/other-app", "latest", { allowScripts: false }).pipe(Effect.flip)
          expect(error).toMatchObject({ _tag: "AppInstallFailed", stage: "fetch" })
          expect(yield* appsJson(root)).toBe(before)
          expect(yield* prefixes(root)).toEqual(["fake"])
        }).pipe(Effect.scoped),
      60_000
    )

    // The package's own declaration is what the user agreed to; the running app may not exceed it.
    it.effect(
      "fails probe when the app asks for services its package does not declare, or exits",
      () =>
        Effect.gen(function*() {
          const root = yield* tempRoot
          const registry = yield* startRegistry
          yield* publish(registry, { name, version: "1.0.0", id: "fake", services: ["jobs.submit"], declared: [] })
          yield* publish(registry, { name: "@knpkv/crash-app", version: "1.0.0", id: "crash", crash: true })
          const { installer } = yield* installerIn(root, registry)
          const asks = yield* installer.add(name, "latest", { allowScripts: false }).pipe(Effect.flip)
          const exits = yield* installer.add("@knpkv/crash-app", "latest", { allowScripts: false }).pipe(Effect.flip)
          expect([asks, exits]).toMatchObject([
            {
              _tag: "AppInstallFailed",
              stage: "probe",
              detail: "it asks for hub services its package does not declare"
            },
            { _tag: "AppInstallFailed", stage: "probe", detail: "it exited with code 3 before answering" }
          ])
          expect(yield* appsJson(root)).toBe("absent")
          expect(yield* prefixes(root)).toEqual([])
        }).pipe(Effect.scoped),
      60_000
    )

    it.effect(
      "refuses an untrusted scope, a declined prompt and a nix-managed apps.json before downloading",
      () =>
        Effect.gen(function*() {
          const root = yield* tempRoot
          const fileSystem = yield* FileSystem.FileSystem
          const registry = yield* startRegistry
          yield* publish(registry, { name: "@elsewhere/app", version: "1.0.0", id: "elsewhere" })
          yield* publish(registry, { name, version: "1.0.0", id: "fake" })
          const declining = yield* installerIn(root, registry, { confirm: Effect.succeed(false) })
          const untrusted = yield* declining.installer.add("@elsewhere/app", "latest", { allowScripts: false }).pipe(
            Effect.flip
          )
          const declined = yield* declining.installer.add(name, "latest", { allowScripts: false }).pipe(Effect.flip)
          yield* fileSystem.makeDirectory(`${root}/config`, { recursive: true })
          yield* fileSystem.writeFileString(
            `${root}/config/apps.json`,
            JSON.stringify({ ...emptyAppsConfig, managedBy: "nix" })
          )
          const managed = yield* declining.installer.add(name, "latest", { allowScripts: false }).pipe(Effect.flip)
          expect([untrusted._tag, declined._tag, managed._tag]).toEqual([
            "AppNotTrusted",
            "AppInstallDeclined",
            "AppsConfigManaged"
          ])
          expect(registry.requests.filter((request) => request.endsWith(".tgz"))).toEqual([])
        }).pipe(Effect.scoped),
      60_000
    )

    // npm fetches the registry's keys for the signature check; a registry that stalls there must not hold the lock.
    it.effect("gives up on the signature check after its timeout, writing nothing", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const registry = yield* startRegistry
        yield* publish(registry, { name, version: "1.0.0", id: "fake" })
        registry.stall("/-/npm/v1/keys")
        const { installer } = yield* installerIn(root, registry, { auditTimeout: Duration.seconds(2) })
        const error = yield* installer.add(name, "latest", { allowScripts: false }).pipe(Effect.flip)
        expect(error).toMatchObject({
          _tag: "AppInstallFailed",
          stage: "signatures",
          detail: "npm audit signatures timed out"
        })
        expect(yield* appsJson(root)).toBe("absent")
        expect(yield* prefixes(root)).toEqual([])
      }).pipe(Effect.scoped), 60_000)

    it.effect("refuses an app whose id is a core module's or an installed app's", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const registry = yield* startRegistry
        yield* publish(registry, { name, version: "1.0.0", id: "fleet" })
        yield* publish(registry, { name: "@knpkv/one", version: "1.0.0", id: "same" })
        yield* publish(registry, { name: "@knpkv/two", version: "1.0.0", id: "same" })
        const { installer } = yield* installerIn(root, registry)
        const core = yield* installer.add(name, "latest", { allowScripts: false }).pipe(Effect.flip)
        yield* installer.add("@knpkv/one", "latest", { allowScripts: false })
        const taken = yield* installer.add("@knpkv/two", "latest", { allowScripts: false }).pipe(Effect.flip)
        expect([core, taken]).toMatchObject([
          { _tag: "AppIdConflict", id: "fleet", with: "core" },
          { _tag: "AppIdConflict", id: "same", with: "app" }
        ])
        expect(yield* prefixes(root)).toEqual(["same"])
      }).pipe(Effect.scoped), 60_000)

    // Deleting files a running child still uses fails on Windows and races elsewhere, so the entry goes first.
    it.effect(
      "removes the entry, waits for the hub to stop the app, then deletes its files",
      () =>
        Effect.gen(function*() {
          const root = yield* tempRoot
          const registry = yield* startRegistry
          yield* publish(registry, { name, version: "1.0.0", id: "fake" })
          const { events, installer, store } = yield* installerIn(root, registry)
          yield* installer.add(name, "latest", { allowScripts: false })
          yield* installer.remove(AppId.make("fake"), { keepFiles: false })
          expect((yield* store.read).apps).toEqual([])
          expect(yield* Ref.get(events)).toEqual(["stopped fake, files present"])
          expect(yield* prefixes(root)).toEqual([])
        }).pipe(Effect.scoped),
      60_000
    )

    it.effect(
      "keeps the files with a notice, and still succeeds, when they can't be deleted yet",
      () =>
        Effect.gen(function*() {
          const root = yield* tempRoot
          const registry = yield* startRegistry
          yield* publish(registry, { name, version: "1.0.0", id: "fake" })
          const busy = (real: FileSystem.FileSystem): FileSystem.FileSystem => ({
            ...real,
            remove: (path, options) =>
              path.endsWith("/hub-apps/fake")
                ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "Busy",
                    module: "FileSystem",
                    method: "remove",
                    pathOrDescriptor: path
                  })
                )
                : real.remove(path, options)
          })
          const { installer, said, store } = yield* installerIn(root, registry, { fileSystem: busy })
          yield* installer.add(name, "latest", { allowScripts: false })
          yield* installer.remove(AppId.make("fake"), { keepFiles: false })
          expect((yield* store.read).apps).toEqual([])
          expect(yield* prefixes(root)).toEqual(["fake"])
          expect((yield* Ref.get(said)).at(-1)).toContain(
            `Removed fake, but its files are still in use; delete ${root}/data/hub-apps/fake later`
          )
        }).pipe(Effect.scoped),
      60_000
    )

    it.effect("refuses to remove an app that is not installed", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const registry = yield* startRegistry
        const { installer } = yield* installerIn(root, registry)
        const error = yield* installer.remove(AppId.make("absent"), { keepFiles: false }).pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "AppNotInstalled", id: "absent" })
      }).pipe(Effect.scoped), 60_000)
  })
})
