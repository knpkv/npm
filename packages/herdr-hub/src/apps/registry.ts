/**
 * The hub's list of installed apps and what it knows about each.
 *
 * **Mental model**
 *
 * - `apps.json` (the `herdr-hub apps` CLI or nix) says which apps are installed and how to run them. The
 *   {@link AppSupervisor} runs each eligible one: not a core module's id, not an id an earlier entry took.
 * - Each running app's manifest is read live from its endpoint, with the spawn's secret, and checked: id,
 *   contract, descriptor. Every outcome is an `AppState`; none fails the hub. A supervisor change (started,
 *   stopped, restarting) probes that app again at once.
 * - The last good manifest per app is cached on disk, so a registered app that is down keeps its real
 *   label and pages. Removing an app from `apps.json` stops it and deletes its cache entry, so its routes
 *   and bookmarks become not-found.
 * - A missing `apps.json` means no apps. An unreadable one keeps the previous list.
 * - The cache directory is 0700 and its files 0600 on POSIX. Windows ignores those modes: owner-only there comes
 *   from the user profile's ACL (an owner-only DACL of our own is a non-goal). The cache holds no secret.
 *
 * @module
 */
import {
  type AppId,
  AppManifest,
  appPaths,
  AppsConfig,
  AppsConfigInvalid,
  type AppState,
  type AppUnavailableReason,
  hubHeaders,
  type InstalledApp,
  validateModuleRegistry
} from "@knpkv/hub-app"
import {
  Cause,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Redacted,
  Result,
  Schedule,
  Schema,
  Stream,
  SynchronizedRef
} from "effect"
import { getJson } from "./socket.js"
import type { AppSupervisor } from "./supervisor.js"

export interface AppRegistryOptions {
  /** `~/.config/herdr/apps.json`. */
  readonly configPath: string
  /** Where last-good manifests are kept, one `<id>.manifest.json` each. */
  readonly cacheDirectory: string
  readonly supervisor: AppSupervisor
  /** Core module ids; an app may not take one. */
  readonly coreIds: ReadonlyArray<string>
  /** Contracts this hub mounts: the current one and the one before it. */
  readonly supportedContracts: ReadonlyArray<number>
  readonly probeTimeoutMillis: number
}

/** How the hub reaches one running app: its endpoint and the secret that spawn checks. */
export interface AppReach {
  readonly endpoint: string
  readonly secret: Redacted.Redacted<string>
}

export interface RegisteredApp {
  readonly id: AppId
  readonly state: AppState
  /** Set while the app runs. */
  readonly reach: AppReach | null
}

/** A GET to a running app, with its spawn's secret. */
export const getFromApp = (reach: AppReach, path: string, timeoutMillis: number) =>
  getJson(reach.endpoint, path, timeoutMillis, { [hubHeaders.appSecret]: Redacted.value(reach.secret) })

const emptyConfig: AppsConfig = { v: 2, managedBy: "cli", trust: { scopes: ["@knpkv"] }, apps: [] }
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(AppsConfig), { onExcessProperty: "error" })
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
  const probe = Effect.fn("AppRegistry.probe")(function*(id: AppId, taken: ReadonlySet<string>) {
    const cached = yield* readCache(id)
    const down = (reason: AppUnavailableReason, manifest: AppManifest | null = cached): RegisteredApp => ({
      id,
      state: unavailable(id, reason, manifest),
      reach: null
    })
    if (options.coreIds.includes(id) || taken.has(id)) return down("duplicate")
    const run = yield* options.supervisor.run(id)
    if (run === undefined || run._tag === "Starting") return down("starting")
    if (run._tag === "Down") return down(run.reason)
    const reach: AppReach = { endpoint: run.endpoint, secret: run.secret }
    const answer = yield* Effect.result(getFromApp(reach, appPaths.manifest, options.probeTimeoutMillis))
    if (Result.isFailure(answer)) return down(answer.failure.reason === "timeout" ? "timeout" : "not_running")
    const manifest = Schema.decodeUnknownResult(AppManifest)(answer.success)
    if (Result.isFailure(manifest)) return down("invalid_manifest")
    const decoded = manifest.success
    if (decoded.id !== id || decoded.module.id !== id) return down("id_mismatch")
    if (!options.supportedContracts.includes(decoded.contract)) return down("incompatible", decoded)
    if (Result.isFailure(validateModuleRegistry([decoded.module]))) return down("invalid_manifest")
    if (cached === null || encodeManifest(cached) !== encodeManifest(decoded)) yield* writeCache(decoded)
    return { id, state: { _tag: "Ready", manifest: decoded }, reach } satisfies RegisteredApp
  })

  /** Ids in `apps.json` order; a repeated id keeps its first entry, later ones are duplicates. */
  const probeAll = (ids: ReadonlyArray<AppId>) =>
    Effect.forEach(ids, (id, index) => probe(id, new Set(ids.slice(0, index))), { concurrency: "unbounded" })

  /** Entries the supervisor may run: not a core module's id, and the first entry for its id. */
  const eligible = (apps: ReadonlyArray<InstalledApp>) =>
    apps.filter((entry, index) =>
      !options.coreIds.includes(entry.id) && apps.findIndex((other) => other.id === entry.id) === index
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
   * Re-read `apps.json`, hand it to the supervisor, retire removed apps' cache entries and probe all. Reload and
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
        yield* options.supervisor.sync(eligible(next))
        for (const gone of previous.filter((app) => !next.some((entry) => entry.id === app.id))) {
          yield* fileSystem.remove(cacheFile(gone.id), { force: true }).pipe(Effect.ignore({ log: true }))
        }
        return yield* probeAll(next.map((entry) => entry.id))
      }))
  })

  /** Probe the registered apps again without re-reading `apps.json`. */
  const refresh = Effect.fn("AppRegistry.refresh")(function*() {
    yield* SynchronizedRef.updateEffect(apps, (current) => probeAll(current.map((app) => app.id)))
  })

  /** Ids with a probe running from {@link probeOne}; a burst of failed requests runs one probe, not a queue. */
  const probing = yield* SynchronizedRef.make<ReadonlySet<AppId>>(new Set())

  /** Probe one registered app again: a proxied request to it failed, or the supervisor changed its run. */
  const probeOne = Effect.fn("AppRegistry.probeOne")(function*(id: AppId) {
    const started = yield* SynchronizedRef.modify(
      probing,
      (current): readonly [boolean, ReadonlySet<AppId>] =>
        current.has(id) ? [false, current] : [true, new Set([...current, id])]
    )
    if (!started) return
    yield* SynchronizedRef.updateEffect(apps, (current) => {
      const index = current.findIndex((app) => app.id === id)
      if (index === -1) return Effect.succeed(current)
      const earlier = new Set(current.slice(0, index).map((other) => other.id))
      return probe(id, earlier).pipe(
        Effect.map((probed) => current.map((entry, position) => position === index ? probed : entry))
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
     * Re-reads `apps.json` when the CLI or nix replaces it. A directory that can't be watched leaves the 30 s loop
     * to pick changes up; forks in the caller's scope.
     */
    watchConfig: fileSystem.watch(path.dirname(options.configPath)).pipe(
      Stream.filter((event) => path.basename(event.path) === path.basename(options.configPath)),
      Stream.debounce("200 millis"),
      Stream.runForEach(() => reload()),
      Effect.catchTag("PlatformError", (error) => Effect.logWarning("apps.json is not watched", error)),
      Effect.forkScoped
    ),
    /** Probes an app as soon as the supervisor changes its run; forks in the caller's scope. */
    watchRuns: options.supervisor.changes.pipe(Stream.runForEach((id) => probeOne(id)), Effect.forkScoped),
    /** Re-reads `apps.json` and re-probes every 30 s, so an edit lands without a signal; forks in the caller's scope. */
    reloadLoop: Effect.sleep("30 seconds").pipe(
      Effect.andThen(logReloadFailure(reload())),
      Effect.repeat(Schedule.forever),
      Effect.forkScoped
    )
  }
})
export type AppRegistry = Effect.Success<ReturnType<typeof makeAppRegistry>>
