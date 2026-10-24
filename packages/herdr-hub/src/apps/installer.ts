/**
 * `apps add` and `apps remove`: the installer's writes to the app prefixes and `apps.json`.
 *
 * Mental model:
 * - **One lock for the whole command** (`AppsStore.withLock`), so two CLIs never interleave a resolve, an install
 *   and a write.
 * - **Add stages, then commits.** The package installs into `<hubData>/hub-apps/.staging-<nonce>` (the id isn't
 *   known until the app answers), its tarball must be the one `npm view` described, its signatures are checked where
 *   the registry signs, and it runs once on a throwaway endpoint. Only then is the staging directory renamed to
 *   `<id>/<version>` and `apps.json` written. A failure at any step deletes staging and leaves `apps.json` as it was.
 * - **Remove writes first, deletes last.** The entry leaves `apps.json`, the hub is given a bounded wait to stop the
 *   app, then its files go. Files that can't be deleted yet (Windows keeps a running script's files busy) stay, with
 *   a notice; the command still succeeds.
 *
 * @since 0.1.0
 */
import { AppId, type AppManifest, type InstalledApp } from "@knpkv/hub-app"
import { Crypto, Effect, FileSystem, Path, Schema } from "effect"
import type { PlatformError } from "effect"
import { Hex } from "effect/encoding"
import { AppInstallFailed, type Npm, type ResolvedApp } from "./npm.js"
import { probeApp } from "./probe.js"
import { AppsConfigManaged, type AppsStore } from "./store.js"
import { type EndpointPlace, entryScript, type RuntimeDirUnsafe } from "./supervisor.js"
import { AppNotTrusted, isTrusted, type SignatureCheck, trustLines } from "./trust.js"

/** The app's id is already a core module's or another installed app's. */
export class AppIdConflict extends Schema.TaggedError<AppIdConflict>()("AppIdConflict", {
  id: Schema.String,
  with: Schema.Literals(["core", "app"])
}) {}

/** No installed app has this id. */
export class AppNotInstalled extends Schema.TaggedError<AppNotInstalled>()("AppNotInstalled", { id: Schema.String }) {}

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
  readonly confirm: (lines: ReadonlyArray<string>) => Effect.Effect<boolean>
  /** Waits (bounded) until the hub reports `id` stopped; returns at once when no hub answers. */
  readonly waitStopped: (id: AppId) => Effect.Effect<void>
  /** A line for the user (notices that don't fail the command). */
  readonly say: (line: string) => Effect.Effect<void>
}

/** A new app's heap cap until the user sets one. */
const defaultMemoryMb = 256

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

  const add = (pkg: string, spec: string, flags: { readonly allowScripts: boolean }) =>
    options.store.withLock((locked) =>
      Effect.gen(function*() {
        const config = yield* locked.read
        // Refused before anything is downloaded; the write would refuse it anyway.
        if (config.managedBy === "nix") return yield* new AppsConfigManaged({ managedBy: "nix" })
        const resolved = yield* options.npm.resolve(pkg, spec)
        if (!isTrusted(config.trust.scopes, resolved.package)) {
          return yield* new AppNotTrusted({ package: resolved.package })
        }
        if (!(yield* options.confirm(trustLines(resolved, null)))) {
          return yield* new AppInstallDeclined({ package: resolved.package })
        }
        const staging = path.join(appsRoot, `.staging-${Hex.encode(yield* cryptoService.randomBytes(8))}`)
        // best-effort: a staging directory left behind is a dot directory nothing reads.
        const dropStaging = Effect.ignore(fileSystem.remove(staging, { recursive: true, force: true }))
        const entry = yield* Effect.gen(function*() {
          yield* options.npm.install(staging, resolved, flags.allowScripts)
          yield* options.say(signatureLine(yield* options.npm.auditSignatures(staging, resolved.package)))
          const bin = path.join("node_modules", resolved.package, resolved.hubApp.bin)
          const failed = (stage: AppInstallFailed["stage"], detail: string) =>
            Effect.fail(new AppInstallFailed({ package: resolved.package, stage, detail }))
          const script = entryScript(
            {
              id: AppId.make("probe"),
              package: resolved.package,
              version: resolved.version,
              dir: staging,
              bin,
              enabled: true,
              memoryMb: defaultMemoryMb,
              allowScripts: flags.allowScripts
            },
            options.windows
          )
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
            memoryMb: defaultMemoryMb
          })
          const mismatch = matchesDeclaration(resolved, manifest)
          if (mismatch !== null) return yield* failed("probe", mismatch)
          if (options.coreModuleIds.includes(manifest.id)) {
            return yield* new AppIdConflict({ id: manifest.id, with: "core" })
          }
          if (config.apps.some((app) => app.id === manifest.id)) {
            return yield* new AppIdConflict({ id: manifest.id, with: "app" })
          }
          const dir = path.join(appsRoot, manifest.id, resolved.version)
          const commit = <A>(step: Effect.Effect<A, PlatformError.PlatformError>) =>
            step.pipe(Effect.catchTag("PlatformError", (error) => failed("commit", error.message)))
          yield* commit(fileSystem.makeDirectory(path.dirname(dir), { recursive: true }))
          // Not in apps.json, so nothing runs from it: a leftover of an earlier, interrupted add.
          yield* commit(fileSystem.remove(dir, { recursive: true, force: true }))
          yield* commit(fileSystem.rename(staging, dir))
          const installed: InstalledApp = {
            id: manifest.id,
            package: resolved.package,
            version: resolved.version,
            dir,
            bin,
            enabled: true,
            memoryMb: defaultMemoryMb,
            allowScripts: flags.allowScripts
          }
          return installed
        }).pipe(Effect.tapError(() => dropStaging))
        yield* locked.write({ ...config, apps: [...config.apps, entry] })
        return entry
      })
    )

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
    yield* options.waitStopped(id)
    // Only a prefix the CLI made is deleted; an entry pointing elsewhere was written by hand.
    const prefixes = path.join(appsRoot, id)
    if (path.relative(prefixes, entry.dir).startsWith("..")) return
    yield* fileSystem.remove(prefixes, { recursive: true, force: true }).pipe(
      Effect.catchTag(
        "PlatformError",
        (error) =>
          options.say(`Removed ${id}, but its files are still in use; delete ${prefixes} later (${error.message}).`)
      )
    )
  })

  return { add, remove }
})

export type AppInstaller = Effect.Success<ReturnType<typeof makeInstaller>>
