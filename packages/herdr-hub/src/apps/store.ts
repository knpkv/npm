/**
 * The CLI's side of `apps.json`: read it, and write it under one lock so two CLIs never interleave.
 *
 * Mental model:
 * - **One writer, named in the file.** `managedBy: "nix"` means home-manager wrote it (usually a store symlink), so
 *   every write is refused with `AppsConfigManaged`; the on-disk marker is re-read under the lock, never taken from
 *   the caller's copy. An absent file reads as an empty `cli` config and is created on the first write.
 * - **Atomic writes.** The next config goes to a temp file in the same directory, then renames over `apps.json`, so
 *   the hub (which only reads) never sees half a file.
 * - **The lock** is `<hubData>/hub-apps/.lock`, created exclusively and held open for the whole command, holding
 *   `{ pid, startedAt, host }`. Its mtime is refreshed every 2 min while held. Another CLI's lock is stale when its
 *   pid is gone (only checked when `host` is this host: a pid means nothing elsewhere) or its mtime is over 10 min
 *   old; then it is taken over, otherwise `AppsLockBusy`.
 *
 * @since 0.1.0
 */
import { AppsConfig, AppsConfigInvalid } from "@knpkv/hub-app"
import { Clock, Crypto, Duration, Effect, FileSystem, Option, Path, Schedule, Schema } from "effect"
import type { PlatformError, Scope } from "effect"
import { Hex } from "effect/encoding"

/** `apps.json` is owned by nix (home-manager); the CLI may read it but never writes it. */
export class AppsConfigManaged extends Schema.TaggedError<AppsConfigManaged>()("AppsConfigManaged", {
  managedBy: Schema.Literal("nix")
}) {}

/** Another CLI holds the apps lock. `pid` is null when its lock file could not be read. */
export class AppsLockBusy extends Schema.TaggedError<AppsLockBusy>()("AppsLockBusy", {
  pid: Schema.NullOr(Schema.Int)
}) {}

const LockRecord = Schema.Struct({ pid: Schema.Int, startedAt: Schema.Int, host: Schema.String })
interface LockRecord extends Schema.Schema.Type<typeof LockRecord> {}
const decodeLock = Schema.decodeUnknownOption(Schema.fromJsonString(LockRecord))
const encodeLock = Schema.encodeSync(Schema.fromJsonString(LockRecord))
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(AppsConfig), { onExcessProperty: "error" })
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(AppsConfig))

/** The config an absent `apps.json` stands for. */
export const emptyAppsConfig: AppsConfig = { v: 2, managedBy: "cli", trust: { scopes: ["@knpkv"] }, apps: [] }

export const lockStaleMillis = Duration.toMillis(Duration.minutes(10))
const lockRefresh = Duration.minutes(2)

export interface AppsStoreOptions {
  readonly configPath: string
  readonly lockPath: string
  /** This process, recorded in the lock and compared with another lock's `host`. */
  readonly self: { readonly pid: number; readonly host: string }
  /** Whether a pid on this host is running; only asked about locks written on this host. */
  readonly processAlive: (pid: number) => Effect.Effect<boolean>
  /** How often a held lock's mtime is refreshed; 2 min by default. */
  readonly refreshEvery?: Duration.Duration
}

/** What a command may do while it holds the lock. */
export interface LockedAppsStore {
  readonly read: Effect.Effect<AppsConfig, AppsConfigInvalid | PlatformError.PlatformError>
  /** Replaces `apps.json`; refused when the file on disk says `managedBy: "nix"`. */
  readonly write: (
    next: AppsConfig
  ) => Effect.Effect<void, AppsConfigManaged | AppsConfigInvalid | PlatformError.PlatformError>
}

export interface AppsStore {
  readonly read: Effect.Effect<AppsConfig, AppsConfigInvalid | PlatformError.PlatformError>
  /** Runs `use` holding the lock, released (and its file removed, if still ours) when `use` ends. */
  readonly withLock: <A, E, R>(
    use: (store: LockedAppsStore) => Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | AppsLockBusy | PlatformError.PlatformError, Exclude<R, Scope.Scope>>
}

const isAlreadyExists = (error: PlatformError.PlatformError) => error.reason._tag === "AlreadyExists"
const isNotFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound"

export const makeAppsStore = Effect.fn("AppsStore.make")(function*(options: AppsStoreOptions) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cryptoService = yield* Crypto.Crypto

  const read = fileSystem.readFileString(options.configPath).pipe(
    Effect.map(Option.some),
    Effect.catchIf(isNotFound, () => Effect.succeed(Option.none<string>())),
    Effect.flatMap(Option.match({
      onNone: () => Effect.succeed(emptyAppsConfig),
      onSome: (text) =>
        decodeConfig(text).pipe(Effect.mapError(() => new AppsConfigInvalid({ path: options.configPath })))
    }))
  )

  const write = Effect.fn("AppsStore.write")(function*(next: AppsConfig) {
    if ((yield* read).managedBy === "nix") return yield* new AppsConfigManaged({ managedBy: "nix" })
    const directory = path.dirname(options.configPath)
    yield* fileSystem.makeDirectory(directory, { recursive: true })
    const temp = path.join(directory, `.apps.json.${Hex.encode(yield* cryptoService.randomBytes(8))}`)
    yield* fileSystem.writeFileString(temp, `${encodeConfig(next)}\n`, { flag: "wx" })
    // best-effort: a temp file left behind is a dot file the hub never reads.
    const dropTemp = Effect.ignore(fileSystem.remove(temp, { force: true }))
    yield* fileSystem.rename(temp, options.configPath).pipe(Effect.tapError(() => dropTemp))
  })

  /** The lock file's text and age, or none when it vanished meanwhile. */
  const inspect = fileSystem.readFileString(options.lockPath).pipe(
    Effect.flatMap((text) =>
      fileSystem.stat(options.lockPath).pipe(Effect.map((info) => ({ text, mtime: Option.getOrUndefined(info.mtime) })))
    ),
    Effect.map(Option.some),
    Effect.catchIf(isNotFound, () => Effect.succeed(Option.none<{ text: string; mtime: Date | undefined }>()))
  )

  const isStale = Effect.fn("AppsStore.isStale")(function*(record: Option.Option<LockRecord>, mtime: Date | undefined) {
    const now = yield* Clock.currentTimeMillis
    if (mtime !== undefined && now - mtime.getTime() > lockStaleMillis) return true
    if (Option.isSome(record) && record.value.host === options.self.host) {
      return !(yield* options.processAlive(record.value.pid))
    }
    return false
  })

  /** `AppsLockBusy` for whoever's lock text is on disk now (`pid` null when it can't be read). */
  const busyNow = inspect.pipe(
    Effect.flatMap((seen) =>
      Effect.fail(
        new AppsLockBusy({
          pid: Option.match(Option.flatMap(seen, (lock) => decodeLock(lock.text)), {
            onNone: () => null,
            onSome: (lock) => lock.pid
          })
        })
      )
    )
  )

  /**
   * Creates the lock file exclusively and keeps it open in the current scope. A lock that was created but not
   * written is removed again, so it never reads as someone else's for ten minutes. Another CLI's lock appearing
   * first is `AppsLockBusy`.
   */
  const create = Effect.fn("AppsStore.createLock")(function*() {
    const record: LockRecord = { ...options.self, startedAt: yield* Clock.currentTimeMillis }
    const file = yield* fileSystem.open(options.lockPath, { flag: "wx", mode: 0o600 })
    // best-effort: the write's own failure is the one reported; a leftover empty lock goes stale by mtime.
    const drop = Effect.ignore(fileSystem.remove(options.lockPath, { force: true }))
    yield* file.writeAll(new TextEncoder().encode(encodeLock(record))).pipe(Effect.tapError(() => drop))
    return record
  })
  const createOrBusy = create().pipe(Effect.catchIf(isAlreadyExists, () => busyNow))

  /**
   * Takes the lock, taking over a stale one once. Right before removing a stale lock its text is read again and must
   * be the text that was judged stale, so a lock another CLI took over meanwhile is left alone. A window remains
   * between that read and the removal, too short for a second CLI to judge, remove and recreate in.
   */
  const acquire = Effect.fn("AppsStore.acquire")(function*() {
    yield* fileSystem.makeDirectory(path.dirname(options.lockPath), { recursive: true })
    const first = yield* create().pipe(
      Effect.map(Option.some),
      Effect.catchIf(isAlreadyExists, () => Effect.succeed(Option.none<LockRecord>()))
    )
    if (Option.isSome(first)) return first.value
    const seen = yield* inspect
    if (Option.isNone(seen)) return yield* createOrBusy
    if (!(yield* isStale(decodeLock(seen.value.text), seen.value.mtime))) return yield* busyNow
    const again = yield* inspect
    if (Option.isSome(again) && again.value.text !== seen.value.text) return yield* busyNow
    yield* fileSystem.remove(options.lockPath, { force: true })
    return yield* createOrBusy
  })

  /** Removes the lock file if it still holds `record` (a takeover after 10 min of silence may have replaced it). */
  // best-effort: a lock left behind goes stale (dead pid, then mtime) and the next CLI takes it over.
  const release = (record: LockRecord) =>
    inspect.pipe(
      Effect.flatMap((seen) =>
        Option.isSome(seen) && seen.value.text === encodeLock(record)
          ? fileSystem.remove(options.lockPath, { force: true })
          : Effect.void
      ),
      Effect.ignore
    )

  // best-effort: a missed refresh only shortens the 10 min window another CLI waits before taking over.
  const touch = Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) => fileSystem.utimes(options.lockPath, new Date(now), new Date(now))),
    Effect.ignore
  )

  const withLock: AppsStore["withLock"] = (use) =>
    Effect.scoped(
      Effect.gen(function*() {
        yield* Effect.acquireRelease(acquire(), release)
        yield* Effect.forkScoped(Effect.repeat(touch, Schedule.spaced(options.refreshEvery ?? lockRefresh)))
        return yield* use({ read, write })
      })
    )

  return { read, withLock } satisfies AppsStore
})
