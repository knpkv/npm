/**
 * How `jcf web login` reaches the running jcf-web server for a fresh sign-in link.
 *
 * **Mental model**
 *
 * - **The file is the door.** jcf-web writes `~/.jcf/web.json` when it starts listening: its loopback
 *   origin and a random control token, owner-only (`0600`), written atomically. Reading the file
 *   already proves the caller is the owner; the token proves it to the server.
 * - **One request, one link.** `POST <origin>/control/login` with `authorization: Bearer <token>`
 *   answers `{ "url": … }`: a one-time link minted the same way as the startup link.
 * - **A stale file is "not running".** When the server is gone, the request cannot connect, and the
 *   answer is the command that starts it.
 *
 * jcf-web owns the server side; this module owns the file format and the client, so `jcf` needs no
 * dependency on jcf-web.
 *
 * @module
 */
import { Clock, Data, Effect, FileSystem, Option, Path, Random, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { HomeDirectory } from "../services/HomeDirectory.js"

export const ControlFile = Schema.Struct({ origin: Schema.String, token: Schema.String })
export type ControlFile = typeof ControlFile.Type

const decodeControlFile = Schema.decodeUnknownEffect(Schema.fromJsonString(ControlFile))
const LoginAnswer = Schema.Struct({ url: Schema.String })

/** The path jcf-web writes and `jcf web login` reads. */
export const controlFilePath = Effect.gen(function*() {
  const path = yield* Path.Path
  return path.join((yield* HomeDirectory).path, ".jcf", "web.json")
})

/** No jcf-web server answers for this user. */
export class WebNotRunning extends Data.TaggedError("WebNotRunning")<{}> {
  override get message() {
    return "jcf-web is not running. Start it with jcf-web; it prints a link."
  }
}

/** The server answered but would not give a link. */
export class WebLoginRefused extends Data.TaggedError("WebLoginRefused")<{ readonly status: number }> {
  override get message() {
    return `jcf-web refused the sign-in request (HTTP ${this.status}). Restart jcf-web for a new link.`
  }
}

/** The control file could not be written or removed. */
export class ControlFileError extends Data.TaggedError("ControlFileError")<{ readonly path: string }> {
  override get message() {
    return `Could not write ${this.path}; jcf web login will not reach this server.`
  }
}

/** A lock older than this was left by a process that died holding it. */
const staleLockMillis = 10_000

/**
 * Runs `effect` holding `~/.jcf/web.lock`, created exclusively, so one server's write and another's
 * check-then-remove never interleave. A lock is retried for about two seconds, and a stale one is broken.
 */
const withControlLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const lock = path.join(path.dirname(yield* controlFilePath), "web.lock")
    yield* fs.makeDirectory(path.dirname(lock), { recursive: true, mode: 0o700 })
    const take = fs.writeFileString(lock, "", { flag: "wx", mode: 0o600 }).pipe(
      Effect.catch(() =>
        Effect.gen(function*() {
          const info = yield* fs.stat(lock)
          const modified = Option.getOrElse(info.mtime, () => new Date(0)).getTime()
          if ((yield* Clock.currentTimeMillis) - modified > staleLockMillis) yield* fs.remove(lock)
          return yield* Effect.fail("held")
        })
      )
    )
    yield* take.pipe(Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 80 }))
    return yield* effect.pipe(Effect.ensuring(
      fs.remove(lock).pipe(
        Effect.ignore({ log: "Warn", message: `Could not release ${lock}; the next writer waits until it goes stale` })
      )
    ))
  })

/** Records this server's origin and control token, replacing any earlier server's file. */
export const writeControlFile = (control: ControlFile) =>
  withControlLock(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = yield* controlFilePath
    yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 })
    const pending = `${file}.${yield* Random.nextIntBetween(0, 1_000_000_000)}.tmp`
    yield* fs.writeFileString(pending, JSON.stringify(control), { mode: 0o600 })
    yield* fs.chmod(pending, 0o600)
    yield* fs.rename(pending, file).pipe(
      Effect.tapError(() =>
        fs.remove(pending).pipe(Effect.ignore({ log: "Warn", message: `Could not remove ${pending}` }))
      )
    )
  })).pipe(
    Effect.catch(() => controlFilePath.pipe(Effect.flatMap((path) => Effect.fail(new ControlFileError({ path })))))
  )

/** Removes the control file if it is still this server's; a newer server's file is left alone. */
export const removeControlFile = (token: string) =>
  withControlLock(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const file = yield* controlFilePath
    const current = yield* fs.readFileString(file).pipe(Effect.flatMap(decodeControlFile))
    if (current.token === token) yield* fs.remove(file)
  })).pipe(
    Effect.ignore({ log: "Warn", message: "Could not remove the jcf-web control file; the next server replaces it" })
  )

/** Asks the running jcf-web for a fresh one-time sign-in link. */
export const requestLoginUrl = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const client = yield* HttpClient.HttpClient
  const control = yield* controlFilePath.pipe(
    Effect.flatMap((file) => fs.readFileString(file)),
    Effect.flatMap(decodeControlFile),
    Effect.mapError(() => new WebNotRunning())
  )
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
  return answer.url
})
