/**
 * `apps add`, `update`, `rollback` and `remove`: the installer's writes to the app prefixes and `apps.json`.
 *
 * Mental model:
 * - **One lock for the whole command** (`AppsStore.withLock`), so two CLIs never interleave a resolve, an install
 *   and a write.
 * - **Add stages, then commits.** The package installs into `<hubData>/hub-apps/.staging-<nonce>` (the id isn't
 *   known until the app answers), its tarball must be the one `npm view` described, its signatures are checked where
 *   the registry signs, and it runs once on a throwaway endpoint. Only then is the staging directory renamed to
 *   `<id>/<version>` and `apps.json` written. A failure at any step deletes staging and leaves `apps.json` as it was.
 * - **Update installs beside, then points.** A new version goes through the same staging, under the same id (an
 *   update that answers as another app is refused), into `<id>/<version>` next to the running one; `apps.json` is
 *   switched and the hub swaps the app. One previous version stays for `rollback`, which rebuilds the entry from that
 *   directory's own `package.json`. Install scripts run only when `--allow-scripts` is passed for that very install.
 * - **Remove writes first, deletes last.** The entry leaves `apps.json`, the hub is given a bounded wait to stop the
 *   app, then its files go. Files that can't be deleted yet (Windows keeps a running script's files busy) stay, with
 *   a notice; the command still succeeds.
 *
 * @since 0.1.0
 */
import { AppId, type AppManifest, type AppsConfig, HubAppPackageField, type InstalledApp } from "@knpkv/hub-app"
import { Crypto, Effect, FileSystem, Path, Schema } from "effect"
import type { PlatformError } from "effect"
import { Hex } from "effect/encoding"
import { AppInstallFailed, type Npm, type ResolvedApp, versionOrder } from "./npm.js"
import { probeApp } from "./probe.js"
import { AppsConfigManaged, type AppsStore } from "./store.js"
import { type EndpointPlace, entryScript, type RuntimeDirUnsafe } from "./supervisor.js"
import { AppNotTrusted, type AppsNeedTerminal, isTrusted, type SignatureCheck, trustLines } from "./trust.js"

/** The app's id is already a core module's or another installed app's. */
export class AppIdConflict extends Schema.TaggedError<AppIdConflict>()("AppIdConflict", {
  id: Schema.String,
  with: Schema.Literals(["core", "app"])
}) {}

/** No installed app has this id. */
export class AppNotInstalled extends Schema.TaggedError<AppNotInstalled>()("AppNotInstalled", { id: Schema.String }) {}

/** `rollback` found no version kept beside the current one. */
export class AppNoPreviousVersion extends Schema.TaggedError<AppNoPreviousVersion>()("AppNoPreviousVersion", {
  id: Schema.String
}) {}

/** The user answered no at the trust prompt. */
export class AppInstallDeclined extends Schema.TaggedError<AppInstallDeclined>()("AppInstallDeclined", {
  package: Schema.String
}) {}

export interface InstallerOptions {
  readonly store: AppsStore
  readonly npm: Npm
  /** `<hubData>`; prefixes live in `<hubData>/hub-apps`. */
  readonly hubData: string
  /** The node apps run on (the CLI's `process.execPath`). */
  readonly node: string
  readonly windows: boolean
  /** Ids the hub's own modules use. */
  readonly coreModuleIds: ReadonlyArray<string>
  /** Where the probe's endpoint goes: prepared by the supervisor's rules, apart from the hub's own directory. */
  readonly probePlace: Effect.Effect<
    EndpointPlace,
    RuntimeDirUnsafe | PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  >
  /** Asks y/N with the trust lines; `--yes` answers yes without asking. */
  readonly confirm: (lines: ReadonlyArray<string>) => Effect.Effect<boolean, AppsNeedTerminal>
  /** Waits (bounded) until the hub reports `id` stopped; returns at once when no hub answers. */
  readonly waitStopped: (id: AppId) => Effect.Effect<void>
  /** A line for the user (notices that don't fail the command). */
  readonly say: (line: string) => Effect.Effect<void>
}

/** A new app's heap cap until the user sets one. */
const defaultMemoryMb = 256

/**
 * The default update range: same major, as npm's caret means it, so `0.x` stays within its minor and `0.0.x` on its
 * patch (both are breaking boundaries below 1.0).
 */
export const sameMajor = (version: string): string => {
  const [major = "0", minor = "0", patch = "0"] = version.split(/[.+-]/u)
  return major !== "0" ? `^${major}` : minor !== "0" ? `^0.${minor}` : `~0.0.${patch}`
}

/** The fields `entryScript` doesn't look at, for checking a staged script before the id is known. */
const placeholder: InstalledApp = {
  id: AppId.make("probe"),
  package: "probe",
  version: "0.0.0",
  dir: "/",
  bin: "probe",
  enabled: true,
  memoryMb: defaultMemoryMb,
  allowScripts: false
}

/** What `rollback` reads from the kept version's own `package.json`. */
const KeptPackage = Schema.Struct({ version: Schema.String, hubApp: HubAppPackageField })
const decodeKept = Schema.decodeUnknownEffect(Schema.fromJsonString(KeptPackage))

const signatureLine = (check: SignatureCheck) =>
  check === "verified" ? "Registry signatures: verified" : "Registry signatures: this registry has none"

/** The probe's manifest against what the package declared before install. */
const matchesDeclaration = (resolved: ResolvedApp, manifest: AppManifest): string | null =>
  manifest.contract !== resolved.hubApp.contract
    ? `it speaks contract ${manifest.contract}, but its package declares ${resolved.hubApp.contract}`
    : manifest.services.some((service) => !resolved.hubApp.services.includes(service))
    ? "it asks for hub services its package does not declare"
    : null

export const makeInstaller = Effect.fn("AppInstaller.make")(function*(options: InstallerOptions) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cryptoService = yield* Crypto.Crypto
  const appsRoot = path.join(options.hubData, "hub-apps")

  /**
   * The trust check, the prompt (with every install script that would run, when scripts are allowed), then the staged
   * install, signatures, probe and `accept` (the id rule of add or update), and the rename to `<id>/<version>`.
   * Staging is deleted on any failure.
   */
  const installNew = Effect.fn("AppInstaller.installNew")(function*(
    config: AppsConfig,
    resolved: ResolvedApp,
    run: { readonly allowScripts: boolean; readonly memoryMb: number },
    accept: (manifest: AppManifest) => Effect.Effect<void, AppIdConflict | AppInstallFailed>
  ) {
    const allowScripts = run.allowScripts
    if (!isTrusted(config.trust.scopes, resolved.package)) {
      return yield* new AppNotTrusted({ package: resolved.package })
    }
    const staging = path.join(appsRoot, `.staging-${Hex.encode(yield* cryptoService.randomBytes(8))}`)
    // best-effort: a staging directory left behind is a dot directory nothing reads.
    const dropStaging = Effect.ignore(fileSystem.remove(staging, { recursive: true, force: true }))
    return yield* Effect.gen(function*() {
      const scripts = allowScripts ? yield* options.npm.installScripts(staging, resolved) : null
      const lines = [
        ...trustLines(resolved, null),
        ...(scripts === null
          ? []
          : [`Install scripts that will run: ${scripts.length === 0 ? "none" : scripts.join(", ")}`])
      ]
      if (!(yield* options.confirm(lines))) return yield* new AppInstallDeclined({ package: resolved.package })
      const failed = (stage: AppInstallFailed["stage"], detail: string) =>
        Effect.fail(new AppInstallFailed({ package: resolved.package, stage, detail }))
      // Never run while installing: signatures are checked on the unpacked tree first, then (the registry's own "has
      // install scripts" flag can be missing) the tree is checked against what was shown, and only then do its
      // scripts run.
      yield* options.npm.install(staging, resolved)
      yield* options.say(signatureLine(yield* options.npm.auditSignatures(staging, resolved.package)))
      if (scripts !== null) {
        const unshown = (yield* options.npm.unpackedScripts(staging, resolved.package))
          .filter((name) => !scripts.includes(name))
        if (unshown.length > 0) {
          return yield* failed(
            "fetch",
            `install scripts differ from what was shown: shown ${
              scripts.length === 0 ? "none" : scripts.join(", ")
            }, found ${unshown.join(", ")}`
          )
        }
        yield* options.npm.runScripts(staging, resolved.package)
      }
      const bin = path.join("node_modules", resolved.package, resolved.hubApp.bin)
      const script = entryScript({ ...placeholder, dir: staging, bin }, options.windows)
      if (script === null) return yield* failed("probe", "its hubApp.bin points outside the package")
      const place = yield* options.probePlace.pipe(
        Effect.catchTags({
          RuntimeDirUnsafe: (error) => failed("probe", `the runtime directory is unusable (${error.reason})`),
          PlatformError: (error) => failed("probe", error.message)
        })
      )
      const manifest = yield* probeApp({
        package: resolved.package,
        node: options.node,
        script,
        cwd: staging,
        place,
        memoryMb: run.memoryMb
      })
      const mismatch = matchesDeclaration(resolved, manifest)
      if (mismatch !== null) return yield* failed("probe", mismatch)
      yield* accept(manifest)
      const dir = path.join(appsRoot, manifest.id, resolved.version)
      const commit = <A>(step: Effect.Effect<A, PlatformError.PlatformError>) =>
        step.pipe(Effect.catchTag("PlatformError", (error) => failed("commit", error.message)))
      yield* commit(fileSystem.makeDirectory(path.dirname(dir), { recursive: true }))
      // Not what apps.json runs, so nothing runs from it: a leftover, or a version kept for rollback being replaced.
      yield* commit(fileSystem.remove(dir, { recursive: true, force: true }))
      yield* commit(fileSystem.rename(staging, dir))
      const installed: InstalledApp = {
        id: manifest.id,
        package: resolved.package,
        version: resolved.version,
        dir,
        bin,
        enabled: true,
        memoryMb: run.memoryMb,
        allowScripts
      }
      return installed
    }).pipe(Effect.tapError(() => dropStaging))
  })

  /** Refused before anything is downloaded; the write would refuse it anyway. */
  const notNix = (config: AppsConfig) =>
    config.managedBy === "nix" ? Effect.fail(new AppsConfigManaged({ managedBy: "nix" })) : Effect.void

  const add = (pkg: string, spec: string, flags: { readonly allowScripts: boolean }) =>
    options.store.withLock((locked) =>
      Effect.gen(function*() {
        const config = yield* locked.read
        yield* notNix(config)
        const resolved = yield* options.npm.resolve(pkg, spec)
        const entry = yield* installNew(config, resolved, {
          allowScripts: flags.allowScripts,
          memoryMb: defaultMemoryMb
        }, (manifest) =>
          options.coreModuleIds.includes(manifest.id)
            ? Effect.fail(new AppIdConflict({ id: manifest.id, with: "core" }))
            : config.apps.some((app) => app.id === manifest.id)
            ? Effect.fail(new AppIdConflict({ id: manifest.id, with: "app" }))
            : Effect.void)
        yield* locked.write({ ...config, apps: [...config.apps, entry] })
        return entry
      })
    )

  /** The version directories under `<hub-apps>/<id>`, highest first. */
  const versionsOf = (id: AppId) =>
    fileSystem.readDirectory(path.join(appsRoot, id)).pipe(
      Effect.map((names) => [...names].sort((left, right) => versionOrder(right, left))),
      Effect.catchTag("PlatformError", () => Effect.succeed<ReadonlyArray<string>>([]))
    )

  /** Deletes every version directory of `id` except `keep`; one that can't go yet stays, with a notice. */
  const prune = Effect.fn("AppInstaller.prune")(function*(id: AppId, keep: ReadonlyArray<string>) {
    for (const version of yield* versionsOf(id)) {
      if (keep.includes(version)) continue
      const dir = path.join(appsRoot, id, version)
      yield* fileSystem.remove(dir, { recursive: true, force: true }).pipe(
        Effect.catchTag("PlatformError", (error) => options.say(`Could not delete ${dir} yet (${error.message}).`))
      )
    }
  })

  /**
   * Installs a newer version of `id` beside the current one and points `apps.json` at it; the hub swaps the running
   * app. The default spec is the newest release of the same major; a major bump needs an explicit `spec`. Install
   * scripts run only when `allowScripts` is passed again. One previous version is kept for `rollback`.
   */
  const update = Effect.fn("AppInstaller.update")(function*(
    id: AppId,
    spec: string | null,
    flags: { readonly allowScripts: boolean }
  ) {
    const outcome = yield* options.store.withLock((locked) =>
      Effect.gen(function*() {
        const config = yield* locked.read
        yield* notNix(config)
        const current = config.apps.find((app) => app.id === id)
        if (current === undefined) return yield* new AppNotInstalled({ id })
        const resolved = yield* options.npm.resolve(current.package, spec ?? sameMajor(current.version))
        if (resolved.version === current.version) return null
        // Without an explicit spec, never go down (the running version may be unpublished or deprecated).
        if (spec === null && versionOrder(resolved.version, current.version) < 0) {
          yield* options.say(
            `${id} stays at ${current.version}: the newest release in its line is ${resolved.version}. Pass a version to change it.`
          )
          return null
        }
        if (current.allowScripts && !flags.allowScripts) {
          yield* options.say(
            "Install scripts were allowed for the previous version; pass --allow-scripts to allow them again."
          )
        }
        const entry = yield* installNew(config, resolved, {
          allowScripts: flags.allowScripts,
          memoryMb: current.memoryMb
        }, (manifest) =>
          manifest.id === id
            ? Effect.void
            : Effect.fail(
              new AppInstallFailed({
                package: resolved.package,
                stage: "probe",
                detail: `this version answers as ${manifest.id}, not ${id}`
              })
            ))
        yield* locked.write({
          ...config,
          apps: config.apps.map((app) => app.id === id ? { ...entry, enabled: app.enabled } : app)
        })
        // Still under the lock, so no other CLI renames a version in meanwhile. Versions other than these two aren't
        // running: the hub runs the new one and is stopping the previous.
        yield* prune(id, [entry.version, current.version])
        return { from: current.version, to: entry.version }
      })
    )
    return outcome
  })

  /**
   * Points `id` back at the version kept by the last update. The entry is rebuilt from that directory's own
   * `package.json` and checked again (its script must stay inside it); nothing remembered is trusted. Two versions are
   * kept, so a second rollback goes back to where the first started: it is a toggle.
   */
  const rollback = Effect.fn("AppInstaller.rollback")(function*(id: AppId) {
    return yield* options.store.withLock((locked) =>
      Effect.gen(function*() {
        const config = yield* locked.read
        yield* notNix(config)
        const current = config.apps.find((app) => app.id === id)
        if (current === undefined) return yield* new AppNotInstalled({ id })
        const previous = (yield* versionsOf(id)).find((version) => version !== current.version)
        if (previous === undefined) return yield* new AppNoPreviousVersion({ id })
        const dir = path.join(appsRoot, id, previous)
        const failed = (detail: string) => new AppInstallFailed({ package: current.package, stage: "commit", detail })
        const declared = yield* fileSystem.readFileString(
          path.join(dir, "node_modules", current.package, "package.json")
        )
          .pipe(
            Effect.flatMap(decodeKept),
            Effect.mapError(() => failed(`the kept version in ${dir} is unreadable`))
          )
        if (declared.version !== previous) {
          return yield* failed(`the kept version in ${dir} says it is ${declared.version}`)
        }
        const bin = path.join("node_modules", current.package, declared.hubApp.bin)
        const restored: InstalledApp = { ...current, version: declared.version, dir, bin }
        if (entryScript(restored, options.windows) === null) {
          return yield* failed("the kept version's hubApp.bin points outside it")
        }
        yield* locked.write({ ...config, apps: config.apps.map((app) => app.id === id ? restored : app) })
        return { from: current.version, to: restored.version }
      })
    )
  })

  const remove = Effect.fn("AppInstaller.remove")(function*(id: AppId, flags: { readonly keepFiles: boolean }) {
    const entry = yield* options.store.withLock((locked) =>
      Effect.gen(function*() {
        const config = yield* locked.read
        const found = config.apps.find((app) => app.id === id)
        if (found === undefined) return yield* new AppNotInstalled({ id })
        yield* locked.write({ ...config, apps: config.apps.filter((app) => app.id !== id) })
        return found
      })
    )
    if (flags.keepFiles) return
    // Not under the lock: the wait can take seconds.
    yield* options.waitStopped(id)
    // Only a prefix the CLI made is deleted; an entry pointing elsewhere was written by hand.
    const prefixes = path.join(appsRoot, id)
    if (path.relative(prefixes, entry.dir).startsWith("..")) return
    yield* options.store.withLock((locked) =>
      Effect.gen(function*() {
        // Added again while the hub stopped it: those files are the new install's now.
        if ((yield* locked.read).apps.some((app) => app.id === id)) return
        yield* fileSystem.remove(prefixes, { recursive: true, force: true }).pipe(
          Effect.catchTag(
            "PlatformError",
            (error) =>
              options.say(`Removed ${id}, but its files are still in use; delete ${prefixes} later (${error.message}).`)
          )
        )
      })
    ).pipe(
      // The entry is already gone, so the remove happened; only the cleanup waits for another CLI to finish.
      Effect.catchTag(
        "AppsLockBusy",
        () => options.say(`Removed ${id}; another apps command is running, so delete ${prefixes} later.`)
      )
    )
  })

  return { add, update, rollback, remove }
})

export type AppInstaller = Effect.Success<ReturnType<typeof makeInstaller>>
