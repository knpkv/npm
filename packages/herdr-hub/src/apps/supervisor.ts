/**
 * The hub runs every installed app as its own child process and keeps it running.
 *
 * **Mental model**
 *
 * - **One fiber per `apps.json` entry**, keyed by app id. A changed entry replaces its fiber (the old child is
 *   stopped first); a removed one is stopped. Each fiber loops: check the entry, spawn, wait for the app to
 *   listen, watch it, and after an exit wait out a backoff before the next spawn.
 * - **A spawn** runs `<node> --max-old-space-size=<memoryMb> <dir>/<bin> --attach` with no shell, so it is the
 *   same on every OS. Line 1 of its stdin is the {@link HubHandshake}: a fresh endpoint (a socket in the 0700
 *   runtime directory, or a Windows named pipe), the hub's URL, a fresh token and a fresh secret. The pipe stays
 *   open; closing it is the stop signal. A stop closes stdin, waits 5 s, then kills.
 * - **Health:** the child exiting is the main signal. Once it listens, `GET /app/manifest` every 30 s (2 s
 *   timeout) must answer as this app; 3 misses in a row stop it with reason `health`.
 * - **Backoff** 1 s, 2 s, 4 s … capped at 60 s, reset after 10 min running. 5 exits in 10 min is `crashloop`:
 *   it stays down until {@link restart} or its entry changes.
 * - **Logs:** stdout and stderr go line by line to `<logs>/<id>.log` (5 MB, one previous file kept); the last
 *   100 lines stay in memory.
 * - **Paths:** the hub owns `<runtime>/apps` (wiped at start, refused when another user owns it or it is wider
 *   than 0700). `dir` must be absolute and `bin` must stay inside it, by the OS's own path rules; an entry that
 *   breaks either, or whose script is missing, is `install_missing`.
 *
 * @module
 */
import { type AppId, AppManifest, appPaths, type AppUnavailableReason, hubHeaders, InstalledApp } from "@knpkv/hub-app"
import {
  Clock,
  Crypto,
  Effect,
  Fiber,
  FiberMap,
  FileSystem,
  Option,
  Path,
  PubSub,
  Queue,
  Redacted,
  Ref,
  Result,
  Schema,
  Stream,
  SynchronizedRef
} from "effect"
import type { Cause, PlatformError } from "effect"
import { Base64Url, Hex } from "effect/encoding"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { posix, win32 } from "node:path"
import type { AppTokens } from "./grants.js"
import { getJson } from "./socket.js"

/** The hub's runtime directory is unsafe for app endpoints: another user owns it, or others may enter it. */
export class RuntimeDirUnsafe extends Schema.TaggedError<RuntimeDirUnsafe>()("RuntimeDirUnsafe", {
  reason: Schema.Literals(["owner", "mode"])
}) {}

export interface SupervisorTiming {
  readonly listenMillis: number
  readonly stopMillis: number
  readonly probeEveryMillis: number
  readonly probeTimeoutMillis: number
  readonly misses: number
  readonly backoffBaseMillis: number
  readonly backoffCapMillis: number
  readonly healthyResetMillis: number
  readonly crashloopExits: number
  readonly crashloopWindowMillis: number
}

export const defaultTiming: SupervisorTiming = {
  listenMillis: 10_000,
  stopMillis: 5_000,
  probeEveryMillis: 30_000,
  probeTimeoutMillis: 2_000,
  misses: 3,
  backoffBaseMillis: 1_000,
  backoffCapMillis: 60_000,
  healthyResetMillis: 600_000,
  crashloopExits: 5,
  crashloopWindowMillis: 600_000
}

/** How long to wait before spawn number `failures + 1` after `failures` exits in a row. */
export const restartDelayMillis = (failures: number, timing: SupervisorTiming): number =>
  Math.min(timing.backoffCapMillis, timing.backoffBaseMillis * 2 ** Math.max(0, failures - 1))

/** Whether the exits at `exits` (ms timestamps) put the app in crashloop at `now`. */
export const inCrashloop = (exits: ReadonlyArray<number>, now: number, timing: SupervisorTiming): boolean =>
  exits.filter((at) => now - at < timing.crashloopWindowMillis).length >= timing.crashloopExits

/** The entry's script by the OS's path rules, or null when `dir` isn't absolute or `bin` escapes it. */
export const entryScript = (entry: InstalledApp, windows: boolean): string | null => {
  const paths = windows ? win32 : posix
  if (!paths.isAbsolute(entry.dir) || paths.isAbsolute(entry.bin)) return null
  const script = paths.resolve(entry.dir, entry.bin)
  const inside = paths.relative(entry.dir, script)
  return inside === "" || inside.startsWith("..") || paths.isAbsolute(inside) ? null : script
}

/** Room left in `sun_path` (104 bytes on macOS, 108 on Linux, one for the terminator). */
const socketPathBytes = 103

/**
 * Where one spawn listens. POSIX: `<apps>/<id>-<nonce8>.sock`. Windows: a named pipe with a 16-hex nonce, so a
 * name someone else created first makes our bind fail instead of being taken over.
 */
export type EndpointPlace =
  | { readonly _tag: "Posix"; readonly directory: string }
  | { readonly _tag: "Windows"; readonly user: string }

export const endpointFor = (
  place: EndpointPlace,
  id: AppId,
  nonce: string
): string =>
  place._tag === "Windows"
    ? `\\\\.\\pipe\\herdr-hub-${place.user}-${id}-${nonce.slice(0, 16)}`
    : posix.join(place.directory, `${id}-${nonce.slice(0, 8)}.sock`)

/** Why one spawn ended: it never listened, it exited, it stopped answering, or it exited after a healthy run. */
type RunEnd = "timeout" | "exited" | "health" | "healthy-exit"
const exitedEnd: RunEnd = "exited"
const healthEnd: RunEnd = "health"

/** What the supervisor knows about one app right now. */
export type AppRun =
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Running"; readonly endpoint: string; readonly secret: Redacted.Redacted<string> }
  | { readonly _tag: "Down"; readonly reason: Extract<AppUnavailableReason, SupervisedReason> }

type SupervisedReason = "not_running" | "crashloop" | "disabled" | "install_missing" | "health" | "timeout"

export interface SupervisorOptions {
  /** The Node that runs the hub; apps run on it too. Null: no app starts (an embedding that didn't name it). */
  readonly node: string | null
  /** Extra Node arguments before the script; tests only. */
  readonly nodeArgs?: ReadonlyArray<string>
  /** `<hubRuntime>`, or null on Windows (named pipes). */
  readonly runtimeDirectory: string | null
  /** The fallback for a runtime directory too long for socket paths (macOS); `$TMPDIR/herdr-hub-<uid>`. */
  readonly shortRuntimeDirectory: string
  readonly logsDirectory: string
  /** The hub's loopback URL, known once its listener is bound. */
  readonly hubUrl: Effect.Effect<string>
  readonly tokens: AppTokens
  /** The OS user, for Windows pipe names and the POSIX owner check; `uid` is -1 on Windows. */
  readonly user: { readonly name: string; readonly uid: number }
  readonly timing?: SupervisorTiming
}

const logLimitBytes = 5 * 1024 * 1024
const memoryLines = 100

/** A Windows pipe name's user part: the login, lowercased, letters and digits only, at most 8. */
const windowsPlace = (user: string): EndpointPlace => ({
  _tag: "Windows",
  user: user.toLowerCase().replace(/[^a-z0-9]/gu, "").slice(0, 8)
})

const randomHex = (cryptoService: Crypto.Crypto, bytes: number) =>
  Effect.map(cryptoService.randomBytes(bytes), Hex.encode)

export const makeSupervisor = Effect.fn("AppSupervisor.make")(function*(options: SupervisorOptions) {
  const timing = options.timing ?? defaultTiming
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cryptoService = yield* Crypto.Crypto
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const windows = options.runtimeDirectory === null

  // The apps' endpoint directory: owner-only, ours, and wiped (a previous hub's children exited on EOF).
  const prepareDirectory = Effect.fn("AppSupervisor.prepareDirectory")(function*(directory: string) {
    if (yield* fileSystem.exists(directory)) {
      const info = yield* fileSystem.stat(directory)
      if (Option.isSome(info.uid) && info.uid.value !== options.user.uid) {
        return yield* new RuntimeDirUnsafe({ reason: "owner" })
      }
      if ((info.mode & 0o077) !== 0) return yield* new RuntimeDirUnsafe({ reason: "mode" })
      for (const entry of yield* fileSystem.readDirectory(directory)) {
        yield* fileSystem.remove(path.join(directory, entry), { recursive: true, force: true })
      }
      return directory
    }
    yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 })
    return directory
  })
  // An unsafe runtime directory keeps every app down; the hub itself still starts.
  const place: Result.Result<EndpointPlace, PlatformError.PlatformError | RuntimeDirUnsafe> = windows
    ? Result.succeed(windowsPlace(options.user.name))
    : yield* prepareDirectory(
      // The longest endpoint is a 64-character id: if it doesn't fit, use the short directory.
      Buffer.byteLength(path.join(options.runtimeDirectory ?? "", "apps", `${"a".repeat(64)}-00000000.sock`)) >
          socketPathBytes
        ? path.join(options.shortRuntimeDirectory, "apps")
        : path.join(options.runtimeDirectory ?? "", "apps")
    ).pipe(
      Effect.map((directory): EndpointPlace => ({ _tag: "Posix", directory })),
      Effect.result
    )

  const runs = yield* SynchronizedRef.make(new Map<AppId, AppRun>())
  const changed = yield* PubSub.unbounded<AppId>()
  const setRun = (id: AppId, run: AppRun) =>
    SynchronizedRef.update(runs, (table) => new Map(table).set(id, run)).pipe(
      Effect.andThen(PubSub.publish(changed, id))
    )
  const recent = yield* Ref.make(new Map<AppId, ReadonlyArray<string>>())
  const entries = yield* Ref.make(new Map<AppId, string>())
  const fibers = yield* FiberMap.make<AppId>()
  const entryJson = Schema.fromJsonString(InstalledApp)
  const encodeEntry = Schema.encodeSync(entryJson)

  /** Append one line of the app's output to its log, rotating at 5 MB; logging never stops an app. */
  const writeLog = Effect.fn("AppSupervisor.writeLog")(function*(id: AppId, line: string) {
    yield* Ref.update(recent, (table) => new Map(table).set(id, [...(table.get(id) ?? []), line].slice(-memoryLines)))
    const file = path.join(options.logsDirectory, `${id}.log`)
    const append = Effect.gen(function*() {
      yield* fileSystem.makeDirectory(options.logsDirectory, { recursive: true, mode: 0o700 })
      const size = yield* fileSystem.stat(file).pipe(
        Effect.map((info) => Number(info.size)),
        // No log yet.
        Effect.catchTag("PlatformError", () => Effect.succeed(0))
      )
      if (size > logLimitBytes) yield* fileSystem.rename(file, `${file}.1`)
      yield* fileSystem.writeFileString(file, `${line}\n`, { flag: "a", mode: 0o600 })
    })
    // best-effort: a full disk or a lost log directory must not stop the app; the last lines stay in memory.
    yield* Effect.ignore(append)
  })

  /** One spawn, from start to exit. Answers why it ended. */
  const runOnce = Effect.fn("AppSupervisor.runOnce")(function*(
    entry: InstalledApp,
    script: string,
    node: string,
    endpointPlace: EndpointPlace
  ) {
    const nonce = yield* randomHex(cryptoService, 16)
    const endpoint = endpointFor(endpointPlace, entry.id, nonce)
    const token = yield* options.tokens.issue(entry.id, nonce)
    yield* Effect.addFinalizer(() => options.tokens.revoke(entry.id, nonce))
    const secret = Redacted.make(Base64Url.encode(yield* cryptoService.randomBytes(32)))
    const handshake = `${
      JSON.stringify({
        v: 1,
        endpoint,
        hubUrl: yield* options.hubUrl,
        hubToken: Redacted.value(token),
        appSecret: Redacted.value(secret)
      })
    }\n`
    const stdin = yield* Queue.unbounded<Uint8Array, Cause.Done>()
    yield* Queue.offer(stdin, new TextEncoder().encode(handshake))
    const child = yield* spawner.spawn(ChildProcess.make(
      node,
      [...(options.nodeArgs ?? []), `--max-old-space-size=${entry.memoryMb}`, script, "--attach"],
      {
        cwd: entry.dir,
        shell: false,
        stdin: { stream: Stream.fromQueue(stdin), endOnDone: true },
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGKILL"
      }
    ))
    // Stop: close stdin, then give the app `stopMillis` to exit before the spawner's own finalizer kills it.
    // best-effort: past the wait, the spawner's finalizer kills the child.
    const awaitExit = child.exitCode.pipe(
      Effect.timeout(timing.stopMillis),
      Effect.ignore
    )
    yield* Effect.addFinalizer(() => Queue.end(stdin).pipe(Effect.andThen(awaitExit)))
    // best-effort: a broken output pipe ends logging, not the app; its exit is watched separately.
    const output = yield* Stream.merge(child.stdout, child.stderr).pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => writeLog(entry.id, line)),
      Effect.ignore,
      Effect.forkScoped
    )
    // An exit counts once its last output is logged (a crash's stack trace comes last), within a second.
    // best-effort: output still flowing after a second is not worth holding the restart for.
    const drained = Fiber.await(output).pipe(
      Effect.timeout(1_000),
      Effect.ignore
    )
    const exited = yield* Effect.forkScoped(child.exitCode.pipe(Effect.exit, Effect.tap(() => drained)))
    const secretHeader = { [hubHeaders.appSecret]: Redacted.value(secret) }
    // Answers as this app, in time: the probe's one notion of healthy.
    const answers = getJson(endpoint, appPaths.manifest, timing.probeTimeoutMillis, secretHeader).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(AppManifest)),
      Effect.map((manifest) => manifest.id === entry.id),
      // No answer, a bad status or a manifest that doesn't decode: each is a miss.
      Effect.catchTags({ AppSocketError: () => Effect.succeed(false), SchemaError: () => Effect.succeed(false) })
    )
    const listening = Effect.gen(function*() {
      const deadline = (yield* Clock.currentTimeMillis) + timing.listenMillis
      while ((yield* Clock.currentTimeMillis) < deadline) {
        if (yield* answers) return true
        yield* Effect.sleep(100)
      }
      return false
    })
    const started = yield* Effect.raceFirst(
      listening.pipe(Effect.map((ok): RunEnd | null => ok ? null : "timeout")),
      Fiber.join(exited).pipe(Effect.as(exitedEnd))
    )
    if (started !== null) return started
    yield* setRun(entry.id, { _tag: "Running", endpoint, secret })
    const startedAt = yield* Clock.currentTimeMillis
    const watched = Effect.gen(function*() {
      let misses = 0
      while (misses < timing.misses) {
        yield* Effect.sleep(timing.probeEveryMillis)
        misses = (yield* answers) ? 0 : misses + 1
      }
      return healthEnd
    })
    const ended = yield* Effect.raceFirst(watched, Fiber.join(exited).pipe(Effect.as(exitedEnd)))
    const ranMillis = (yield* Clock.currentTimeMillis) - startedAt
    const end: RunEnd = ranMillis >= timing.healthyResetMillis ? "healthy-exit" : ended
    return end
  }, Effect.scoped)

  /** Keep one entry running until its fiber is interrupted. */
  const supervise = Effect.fn("AppSupervisor.supervise")(function*(entry: InstalledApp) {
    if (!entry.enabled) {
      yield* setRun(entry.id, { _tag: "Down", reason: "disabled" })
      return yield* Effect.never
    }
    if (options.node === null || Result.isFailure(place)) {
      yield* writeLog(
        entry.id,
        options.node === null
          ? "hub: started without its Node path, so it runs no apps"
          : `hub: the runtime directory for apps is unusable (${
            Result.isFailure(place) && place.failure._tag === "RuntimeDirUnsafe" ? place.failure.reason : "unreadable"
          })`
      )
      yield* setRun(entry.id, { _tag: "Down", reason: "not_running" })
      return yield* Effect.never
    }
    const node = options.node
    const endpointPlace = place.success
    const script = entryScript(entry, windows)
    const present = script === null
      ? false
      : yield* fileSystem.exists(script).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(false)))
    if (script === null || !present) {
      yield* writeLog(entry.id, `hub: ${entry.package}@${entry.version} is not installed where apps.json says`)
      yield* setRun(entry.id, { _tag: "Down", reason: "install_missing" })
      return yield* Effect.never
    }
    let failures = 0
    let exits: ReadonlyArray<number> = []
    while (true) {
      yield* setRun(entry.id, { _tag: "Starting" })
      const ended = yield* runOnce(entry, script, node, endpointPlace).pipe(
        Effect.catch(() => writeLog(entry.id, "hub: the app could not be started").pipe(Effect.as(exitedEnd)))
      )
      const now = yield* Clock.currentTimeMillis
      if (ended === "healthy-exit") {
        failures = 0
        exits = []
      }
      failures += 1
      exits = [...exits, now]
      if (inCrashloop(exits, now, timing)) {
        yield* setRun(entry.id, { _tag: "Down", reason: "crashloop" })
        return yield* Effect.never
      }
      yield* setRun(entry.id, {
        _tag: "Down",
        reason: ended === "health" ? "health" : ended === "timeout" ? "timeout" : "not_running"
      })
      yield* Effect.sleep(restartDelayMillis(failures, timing))
    }
  })

  /** Start, replace or stop fibers so they match `apps`; an unchanged entry keeps its running child. */
  const sync = Effect.fn("AppSupervisor.sync")(function*(apps: ReadonlyArray<InstalledApp>) {
    const known = yield* Ref.get(entries)
    for (const [id] of known) {
      if (!apps.some((entry) => entry.id === id)) {
        yield* FiberMap.remove(fibers, id)
        yield* SynchronizedRef.update(runs, (table) => {
          const next = new Map(table)
          next.delete(id)
          return next
        })
      }
    }
    const next = new Map<AppId, string>()
    for (const entry of apps) {
      const encoded = encodeEntry(entry)
      next.set(entry.id, encoded)
      if (known.get(entry.id) !== encoded) yield* FiberMap.run(fibers, entry.id, supervise(entry))
    }
    yield* Ref.set(entries, next)
  })

  /** Clear a crashloop (or any wait) by starting the entry's fiber again. */
  const restart = Effect.fn("AppSupervisor.restart")(function*(id: AppId) {
    const encoded = (yield* Ref.get(entries)).get(id)
    if (encoded === undefined) return false
    yield* FiberMap.run(fibers, id, supervise(Schema.decodeSync(entryJson)(encoded)))
    return true
  })

  return {
    sync,
    restart,
    run: (id: AppId) => Effect.map(SynchronizedRef.get(runs), (table) => table.get(id)),
    /** Each app whose run changed (starting, running, down), as it happens. */
    changes: Stream.fromPubSub(changed),
    /** The app's last lines of output, newest last. */
    recentLines: (id: AppId) => Effect.map(Ref.get(recent), (table) => table.get(id) ?? [])
  }
})
export type AppSupervisor = Effect.Success<ReturnType<typeof makeSupervisor>>
