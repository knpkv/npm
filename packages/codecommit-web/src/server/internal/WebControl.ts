/**
 * The owner-only control file lets the CLI request a fresh link from a running server.
 * `~/.codecommit/web.json` persists {origin, token}: the direct bound loopback origin and a
 * server-private bearer credential. The directory is 0700, the file 0600; linked or permissive
 * paths are refused. Neither the token nor this file belongs in HTTP projections or logs.
 * Host reads may project only its validated loopback origin to authenticated clients.
 * Login replies carry a one-time credential URL, emitted only on CLI stdout and to its opener.
 *
 * @module
 */
import { PairingCode } from "@knpkv/browser-pairing"
import { devPublicOrigin, requireLoopbackOrigin } from "@knpkv/browser-pairing/owner-session"
import { Clock, Config, Data, Effect, FileSystem, Option, Path, Random, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { CodeOwnerUi } from "../../host-contract.js"

/** Credential-bearing on-disk representation; the token stays server-private and owner-only. */
export const ControlFile = Schema.Struct({
  origin: Schema.String,
  token: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
})
export interface ControlFile extends Schema.Schema.Type<typeof ControlFile> {}
const decodeControlFile = Schema.decodeUnknownEffect(Schema.fromJsonString(ControlFile))
const LoginAnswer = Schema.Struct({ url: Schema.URLFromString })

export const controlFilePath = Effect.gen(function*() {
  const path = yield* Path.Path
  const home = yield* Config.String("HOME").pipe(Config.orElse(() => Config.String("USERPROFILE")))
  return path.join(home, ".codecommit", "web.json")
})

export class WebNotRunning extends Data.TaggedError("WebNotRunning")<{}> {
  override readonly message = "CodeCommit web is not running. Start it with codecommit web; it prints a link."
}
export class WebLoginRefused extends Data.TaggedError("WebLoginRefused")<{ readonly status: number }> {
  override get message() {
    return `CodeCommit web refused the sign-in request (HTTP ${this.status}). Restart it for a new link.`
  }
}
export class ControlFileError extends Data.TaggedError("ControlFileError")<{}> {
  override readonly message = "Could not publish the owner-only CodeCommit web control file."
}

/** readLink also detects dangling links, which exists/stat would otherwise follow or miss. */
const refuseLink = Effect.fn("CodeCommitWeb.refuseControlLink")(function*(file: string) {
  const fs = yield* FileSystem.FileSystem
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) return yield* new ControlFileError()
})
const requirePrivatePath = Effect.fn("CodeCommitWeb.requirePrivateControlPath")(function*(
  file: string,
  kind: "File" | "Directory",
  mode: number
) {
  yield* refuseLink(file)
  const fs = yield* FileSystem.FileSystem
  const info = yield* fs.stat(file)
  if (info.type !== kind || (info.mode & 0o777) !== mode) return yield* new ControlFileError()
})

/** Read only the public origin projection; ignore credential keys and never mint a login link. */
export const readCodeOwnerUi = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = yield* controlFilePath
  yield* requirePrivatePath(path.dirname(file), "Directory", 0o700)
  yield* requirePrivatePath(file, "File", 0o600)
  const projection = yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ origin: CodeOwnerUi }))))
  )
  return projection.origin
}).pipe(Effect.mapError(() => new WebNotRunning()))
const prepareDirectory = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = path.dirname(yield* controlFilePath)
  yield* refuseLink(directory)
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
  // The cache's descriptor boundary repairs its own directory on startup. This portable control
  // module refuses permissive existing directories rather than chmodding an unpinned path.
  yield* requirePrivatePath(directory, "Directory", 0o700)
})
const staleLockMillis = 10_000

/** Serialize atomic replacement and token-matching removal; recover a lock left by a dead writer. */
const withControlLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const lock = path.join(path.dirname(yield* controlFilePath), "web.lock")
    yield* prepareDirectory
    yield* refuseLink(lock)
    const take = fs.writeFileString(lock, "", { flag: "wx", mode: 0o600 }).pipe(
      Effect.catch((error) =>
        error._tag === "PlatformError" && error.reason._tag === "AlreadyExists"
          ? Effect.gen(function*() {
            yield* requirePrivatePath(lock, "File", 0o600)
            const info = yield* fs.stat(lock)
            const modified = Option.getOrElse(info.mtime, () => new Date(0)).getTime()
            if ((yield* Clock.currentTimeMillis) - modified > staleLockMillis) yield* fs.remove(lock)
            return yield* error
          })
          : Effect.fail(error)
      )
    )
    return yield* Effect.acquireUseRelease(
      take.pipe(Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 80 })),
      () => effect,
      () => fs.remove(lock).pipe(Effect.ignore({ log: "Warn", message: "Could not release the web control lock" }))
    )
  })

/** Atomically record this listening server, replacing an older server's control file. */
export const writeControlFile = (control: ControlFile) =>
  withControlLock(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const file = yield* controlFilePath
    yield* refuseLink(file)
    if (yield* fs.exists(file)) yield* requirePrivatePath(file, "File", 0o600)
    const pending = `${file}.${yield* Random.nextIntBetween(0, 1_000_000_000)}.tmp`
    yield* Effect.acquireUseRelease(
      fs.writeFileString(pending, JSON.stringify(control), { flag: "wx", mode: 0o600 }),
      () => requirePrivatePath(pending, "File", 0o600).pipe(Effect.andThen(fs.rename(pending, file))),
      () =>
        fs.remove(pending, { force: true }).pipe(
          Effect.ignore({ log: "Warn", message: "Could not remove pending web control file" })
        )
    )
  })).pipe(Effect.mapError(() => new ControlFileError()))

/** Publish only from the listener-ready callback; immediately register token-matching scope cleanup. */
export const registerControlFile = (control: ControlFile) =>
  Effect.acquireRelease(writeControlFile(control), () => removeControlFile(control.token))

/** An old server cannot erase a newer server's token, even while another writer is publishing. */
export const removeControlFile = (token: string) =>
  withControlLock(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const file = yield* controlFilePath
    yield* refuseLink(file)
    if (!(yield* fs.exists(file))) return
    yield* requirePrivatePath(file, "File", 0o600)
    const current = yield* fs.readFileString(file).pipe(Effect.flatMap(decodeControlFile))
    if (current.token === token) yield* fs.remove(file)
  })).pipe(Effect.ignore({ log: "Warn", message: "Could not remove the CodeCommit web control file" }))

/** One owner-authenticated request; a refusal or malformed reply never permits a second server. */
export const requestLoginUrl = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const client = yield* HttpClient.HttpClient
  const control = yield* Effect.gen(function*() {
    const file = yield* controlFilePath
    yield* requirePrivatePath(path.dirname(file), "Directory", 0o700)
    yield* requirePrivatePath(file, "File", 0o600)
    const value = yield* fs.readFileString(file).pipe(Effect.flatMap(decodeControlFile))
    const origin = yield* requireLoopbackOrigin(value.origin)
    return { origin, token: value.token }
  }).pipe(Effect.mapError(() => new WebNotRunning()))
  const response = yield* client.execute(
    HttpClientRequest.post(`${control.origin}/control/login`).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${control.token}`)
    )
  ).pipe(Effect.mapError(() => new WebNotRunning()))
  if (response.status !== 200) return yield* new WebLoginRefused({ status: response.status })
  const answer = yield* response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(LoginAnswer)),
    Effect.mapError(() => new WebLoginRefused({ status: response.status }))
  )
  const url = answer.url
  if (
    (url.origin !== control.origin && url.origin !== devPublicOrigin) || url.username !== "" ||
    url.password !== "" || url.pathname !== "/" || url.search !== "" || !url.hash.startsWith("#bootstrap_token=") ||
    !Schema.is(PairingCode)(url.hash.slice("#bootstrap_token=".length))
  ) return yield* new WebLoginRefused({ status: response.status })
  return url.href
})
