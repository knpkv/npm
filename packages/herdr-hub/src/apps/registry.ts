/**
 * The hub's list of installed apps and what it knows about each.
 *
 * **Mental model**
 *
 * - `apps.json` (nix) says which apps are registered and where their sockets are. Nothing else.
 * - Each app's manifest is read live from its socket and checked: id, contract, descriptor, no collision
 *   with a core module or another app. Every outcome is an `AppState`; none fails the hub.
 * - The last good manifest per app is cached on disk, so a registered app that is down keeps its real
 *   label and pages. Removing an app from `apps.json` deletes its cache entry and token, so its routes
 *   and bookmarks become not-found.
 * - A missing `apps.json` means no apps. An unreadable one keeps the previous list.
 *
 * @module
 */
import {
  type AppId,
  AppManifest,
  appPaths,
  AppsConfigInvalid,
  AppsConfigV1,
  type AppState,
  type AppUnavailableReason,
  validateModuleRegistry
} from "@knpkv/hub-app"
import {
  Cause,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Result,
  Schedule,
  Schema,
  Stream,
  SynchronizedRef
} from "effect"
import type { AppTokens } from "./grants.js"
import { getJson } from "./socket.js"

export interface AppRegistryOptions {
  /** `~/.config/herdr/apps.json`. */
  readonly configPath: string
  /** Where last-good manifests are kept, one `<id>.manifest.json` each. */
  readonly cacheDirectory: string
  readonly tokens: AppTokens
  /** Core module ids; an app may not take one. */
  readonly coreIds: ReadonlyArray<string>
  /** Contracts this hub mounts: the current one and the one before it. */
  readonly supportedContracts: ReadonlyArray<number>
  readonly probeTimeoutMillis: number
}

export interface RegisteredApp {
  readonly id: AppId
  readonly socket: string
  readonly state: AppState
}

const emptyConfig: AppsConfigV1 = { v: 1, apps: [] }
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(AppsConfigV1), { onExcessProperty: "error" })
const decodeCached = Schema.decodeUnknownOption(Schema.fromJsonString(AppManifest))
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(AppManifest))

/** Public copy for each reason; never a path or a provider error. */
export const unavailableDetail = (label: string, reason: AppUnavailableReason): string => {
  switch (reason) {
    case "starting":
      return `${label} is starting.`
    case "not_running":
      return `${label} isn't running.`
    case "crashloop":
      return `${label} kept stopping, so it was left off. Restart it once it's fixed.`
    case "disabled":
      return `${label} is turned off.`
    case "install_missing":
      return `${label}'s files are missing. Update it to install them again.`
    case "health":
      return `${label} stopped answering and is being restarted.`
    case "timeout":
      return `${label} didn't answer in time.`
    case "invalid_manifest":
      return `${label} described itself in a way this hub can't read.`
    case "id_mismatch":
      return `${label} answered as a different app.`
    case "incompatible":
      return `${label} needs a different version of the hub.`
    case "duplicate":
      return `${label} uses a name another module already has.`
    case "client_failed":
      return `${label} couldn't be shown.`
  }
}

/** A failed reload (an error or a defect) is logged and its loop goes on; only an interruption ends it. */
export const logReloadFailure = <E>(reload: Effect.Effect<void, E>): Effect.Effect<void, E> =>
  Effect.exit(reload).pipe(
    Effect.flatMap((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : Cause.hasInterrupts(exit.cause)
        ? Effect.failCause(exit.cause)
        : Effect.logError("Apps reload failed; retrying in 30 seconds", exit.cause)
    )
  )

export const makeAppRegistry = Effect.fn("AppRegistry.make")(function*(options: AppRegistryOptions) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const apps = yield* SynchronizedRef.make<ReadonlyArray<RegisteredApp>>([])
  const cacheFile = (id: AppId) => path.join(options.cacheDirectory, `${id}.manifest.json`)

  const readCache = (id: AppId) =>
    fileSystem.readFileString(cacheFile(id)).pipe(
      Effect.map((text) => Option.getOrNull(decodeCached(text))),
      // No cache yet is the usual case for a new app.
      Effect.catchTag("PlatformError", () => Effect.succeed(null))
    )

  const writeCache = (manifest: AppManifest) =>
    fileSystem.makeDirectory(options.cacheDirectory, { recursive: true, mode: 0o700 }).pipe(
      Effect.andThen(fileSystem.writeFileString(cacheFile(manifest.id), encodeManifest(manifest), { mode: 0o600 })),
      Effect.catch((error) => Effect.logWarning("App manifest cache not written", error))
    )

  const unavailable = (
    id: AppId,
    reason: AppUnavailableReason,
    manifest: AppManifest | null
  ): AppState => ({
    _tag: "Unavailable",
    id,
    manifest,
    reason,
    detail: unavailableDetail(manifest?.module.label ?? id, reason)
  })

  /**
   * Ask one app who it is and check the answer. The cached manifest backs every failure but one: an app on a
   * contract this hub doesn't speak keeps the manifest it just sent, so the newer app's own label shows.
   * The cache is rewritten only when the manifest changed.
   */
  const probe = Effect.fn("AppRegistry.probe")(function*(id: AppId, socket: string, taken: ReadonlySet<string>) {
    const cached = yield* readCache(id)
    if (options.coreIds.includes(id) || taken.has(id)) return unavailable(id, "duplicate", cached)
    const answer = yield* Effect.result(getJson(socket, appPaths.manifest, options.probeTimeoutMillis))
    if (Result.isFailure(answer)) {
      return unavailable(id, answer.failure.reason === "timeout" ? "timeout" : "not_running", cached)
    }
    const manifest = Schema.decodeUnknownResult(AppManifest)(answer.success)
    if (Result.isFailure(manifest)) return unavailable(id, "invalid_manifest", cached)
    const decoded = manifest.success
    if (decoded.id !== id || decoded.module.id !== id) return unavailable(id, "id_mismatch", cached)
    if (!options.supportedContracts.includes(decoded.contract)) return unavailable(id, "incompatible", decoded)
    if (Result.isFailure(validateModuleRegistry([decoded.module]))) {
      return unavailable(id, "invalid_manifest", cached)
    }
    if (cached === null || encodeManifest(cached) !== encodeManifest(decoded)) yield* writeCache(decoded)
    return { _tag: "Ready", manifest: decoded } satisfies AppState
  })

  const probeAll = (entries: ReadonlyArray<{ readonly id: AppId; readonly socket: string }>) =>
    Effect.forEach(
      entries,
      (entry, index) => {
        // A repeated id keeps its first registration; later ones are duplicates.
        const earlier = new Set(entries.slice(0, index).map((other) => other.id))
        return probe(entry.id, entry.socket, earlier).pipe(
          Effect.map((state): RegisteredApp => ({ ...entry, state }))
        )
      },
      { concurrency: "unbounded" }
    )

  const readConfig = fileSystem.exists(options.configPath).pipe(
    Effect.flatMap((exists) =>
      exists
        ? fileSystem.readFileString(options.configPath).pipe(Effect.flatMap(decodeConfig))
        : Effect.succeed(emptyConfig)
    ),
    Effect.mapError(() => new AppsConfigInvalid({ path: options.configPath }))
  )

  /**
   * Re-read `apps.json`, retire removed apps, issue tokens for new ones and probe all. Reload and
   * refresh both run inside the ref's lock, so a slow refresh can't overwrite a newer list.
   */
  const reload = Effect.fn("AppRegistry.reload")(function*() {
    const config = yield* Effect.result(readConfig)
    if (Result.isFailure(config)) {
      yield* Effect.logWarning("apps.json is invalid; keeping the previous app list")
      return yield* refresh()
    }
    const next = config.success.apps
    yield* SynchronizedRef.updateEffect(apps, (previous) =>
      Effect.gen(function*() {
        for (const gone of previous.filter((app) => !next.some((entry) => entry.id === app.id))) {
          yield* options.tokens.revoke(gone.id).pipe(Effect.ignore({ log: true }))
          yield* fileSystem.remove(cacheFile(gone.id), { force: true }).pipe(Effect.ignore({ log: true }))
        }
        for (const added of next.filter((entry) => !previous.some((app) => app.id === entry.id))) {
          yield* options.tokens.issue(added.id).pipe(
            Effect.catch((error) => Effect.logWarning("App token not written", error))
          )
        }
        return yield* probeAll(next)
      }))
  })

  /** Probe the registered apps again without re-reading `apps.json`. */
  const refresh = Effect.fn("AppRegistry.refresh")(function*() {
    yield* SynchronizedRef.updateEffect(
      apps,
      (current) => probeAll(current.map(({ id, socket }) => ({ id, socket })))
    )
  })

  /** Ids with a probe running from {@link probeOne}; a burst of failed requests runs one probe, not a queue. */
  const probing = yield* SynchronizedRef.make<ReadonlySet<AppId>>(new Set())

  /** Probe one registered app again, after a proxied request to it failed; the probe decides its state. */
  const probeOne = Effect.fn("AppRegistry.probeOne")(function*(id: AppId) {
    const started = yield* SynchronizedRef.modify(
      probing,
      (current): readonly [boolean, ReadonlySet<AppId>] =>
        current.has(id) ? [false, current] : [true, new Set([...current, id])]
    )
    if (!started) return
    yield* SynchronizedRef.updateEffect(apps, (current) => {
      const index = current.findIndex((app) => app.id === id)
      const app = current[index]
      if (app === undefined) return Effect.succeed(current)
      const earlier = new Set(current.slice(0, index).map((other) => other.id))
      return probe(app.id, app.socket, earlier).pipe(
        Effect.map((state) => current.map((entry, position) => position === index ? { ...entry, state } : entry))
      )
    }).pipe(
      Effect.ensuring(
        SynchronizedRef.update(probing, (current) => new Set([...current].filter((other) => other !== id)))
      )
    )
  })

  return {
    reload,
    refresh,
    probeOne,
    /** Registered apps in `apps.json` order. */
    apps: SynchronizedRef.get(apps),
    /**
     * Re-reads `apps.json` when nix replaces it. A directory that can't be watched leaves the 30 s loop
     * to pick changes up; forks in the caller's scope.
     */
    watchConfig: fileSystem.watch(path.dirname(options.configPath)).pipe(
      Stream.filter((event) => path.basename(event.path) === path.basename(options.configPath)),
      Stream.debounce("200 millis"),
      Stream.runForEach(() => reload()),
      Effect.catchTag("PlatformError", (error) => Effect.logWarning("apps.json is not watched", error)),
      Effect.forkScoped
    ),
    /** Re-reads `apps.json` and re-probes every 30 s, so an edit lands without a signal; forks in the caller's scope. */
    reloadLoop: Effect.sleep("30 seconds").pipe(
      Effect.andThen(logReloadFailure(reload())),
      Effect.repeat(Schedule.forever),
      Effect.forkScoped
    )
  }
})
export type AppRegistry = Effect.Success<ReturnType<typeof makeAppRegistry>>
