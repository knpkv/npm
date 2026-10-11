/** Owner-only local login channel. Credential URLs never enter diagnostics, logs, or telemetry. */
import { NodeSocket, NodeSocketServer } from "@effect/platform-node"
import { PairingCode } from "@knpkv/browser-pairing"
import type { OwnerSessionService } from "@knpkv/browser-pairing/owner-session"
import { Effect, FileSystem, Option, Path, Predicate, Ref, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type { Socket, SocketServer } from "effect/socket"
import { mintBootstrapUrl } from "./OwnerSession.js"

export class ControlError extends Schema.TaggedError<ControlError>()("ControlError", {
  reason: Schema.Literals([
    "unsafe",
    "io",
    "occupied",
    "path-limit",
    "invalid-reply",
    "timeout",
    "unsupported-platform"
  ])
}) {}

/** Paths are server-private. The effective UID is read once at the executable boundary. */
export interface ControlOptions {
  readonly directory: string
  readonly port: number
  readonly uid: number
}

const errnoSchema = Schema.Struct({ code: Schema.String })
const errno = (error: PlatformError | Socket.SocketError | SocketServer.SocketServerError): string | undefined =>
  Option.getOrUndefined(
    Schema.decodeUnknownOption(errnoSchema)(
      error._tag === "PlatformError" ? error.cause : error.reason.cause
    )
  )?.code

const unsafe = () => new ControlError({ reason: "unsafe" })
const io = () => new ControlError({ reason: "io" })

/** Check the final component without following a symlink. EINVAL alone proves it is not a link. */
const refuseLink = (fs: FileSystem.FileSystem, path: string) =>
  fs.readLink(path).pipe(Effect.matchEffect({
    onSuccess: () => Effect.fail(unsafe()),
    onFailure: (error) =>
      error.reason._tag === "NotFound" || errno(error) === "EINVAL" ?
        Effect.void :
        Effect.fail(unsafe())
  }))

const location = Effect.fnUntraced(function*(options: ControlOptions) {
  const path = yield* Path.Path
  if (path.sep !== "/" || options.uid < 0) return yield* new ControlError({ reason: "unsupported-platform" })
  const socket = path.join(options.directory, `serve-${options.port}.sock`)
  if (new TextEncoder().encode(socket).byteLength > 103) return yield* new ControlError({ reason: "path-limit" })
  return socket
})

/** Existing directories must already be owned by this user and 0700; never tighten someone else's directory. */
const inspectDirectory = Effect.fnUntraced(function*(options: ControlOptions, create: boolean) {
  const fs = yield* FileSystem.FileSystem
  yield* refuseLink(fs, options.directory)
  const present = yield* fs.exists(options.directory).pipe(Effect.mapError(io))
  if (!present) {
    if (!create) return false
    yield* fs.makeDirectory(options.directory, { recursive: true, mode: 0o700 }).pipe(Effect.mapError(io))
  }
  const info = yield* fs.stat(options.directory).pipe(Effect.mapError(io))
  if (
    info.type !== "Directory" || Option.getOrUndefined(info.uid) !== options.uid || (info.mode & 0o777) !== 0o700
  ) return yield* unsafe()
  return true
})

const inspectSocket = Effect.fnUntraced(function*(options: ControlOptions, socket: string) {
  const fs = yield* FileSystem.FileSystem
  yield* refuseLink(fs, socket)
  if (!(yield* fs.exists(socket).pipe(Effect.mapError(io)))) return undefined
  const info = yield* fs.stat(socket).pipe(Effect.mapError(io))
  if (info.type !== "Socket" || Option.getOrUndefined(info.uid) !== options.uid || (info.mode & 0o777) !== 0o600) {
    return yield* unsafe()
  }
  const inode = Option.getOrUndefined(info.ino)
  if (inode === undefined) return yield* unsafe()
  return inode
})

/** Bound both bytes and time, including peers that disconnect or never finish a line. */
const readLine = Effect.fnUntraced(function*(reader: Socket.Reader) {
  const decoder = new TextDecoder()
  let text = ""
  let bytes = 0
  while (!text.includes("\n")) {
    const chunks = yield* reader.pull.pipe(Effect.mapError(io))
    for (const chunk of chunks) {
      bytes += Predicate.isString(chunk) ? new TextEncoder().encode(chunk).byteLength : chunk.byteLength
      if (bytes > 4096) return yield* new ControlError({ reason: "invalid-reply" })
      text += Predicate.isString(chunk) ? chunk : decoder.decode(chunk, { stream: true })
    }
  }
  if (text.indexOf("\n") !== text.length - 1) return yield* new ControlError({ reason: "invalid-reply" })
  return text.slice(0, -1)
})

/** Bind atomically; refuse all pre-existing entries. Never unlink a possibly live server during startup. */
export const controlSocket = Effect.fn("AlchemyConsole.controlSocket")(function*(
  options: ControlOptions,
  session: OwnerSessionService,
  listening: Effect.Effect<void>
) {
  const fs = yield* FileSystem.FileSystem
  const socketPath = yield* location(options)
  yield* inspectDirectory(options, true)
  yield* refuseLink(fs, socketPath)
  if (yield* fs.exists(socketPath).pipe(Effect.mapError(io))) return yield* new ControlError({ reason: "occupied" })
  const identity = yield* Ref.make<number | undefined>(undefined)
  const server = yield* NodeSocketServer.make({ path: socketPath }).pipe(
    Effect.mapError((error) => new ControlError({ reason: errno(error) === "EADDRINUSE" ? "occupied" : "io" }))
  )
  // Register cleanup immediately after successful bind; identity checks prevent deleting a replacement.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function*() {
      const inode = yield* Ref.get(identity)
      const current = yield* fs.stat(socketPath)
      if (inode !== undefined && Option.getOrUndefined(current.ino) === inode && current.type === "Socket") {
        yield* refuseLink(fs, socketPath)
        yield* fs.remove(socketPath)
      }
    }).pipe(
      Effect.catch(() => Effect.logWarning("Alchemy console control cleanup failed; a stale socket may need removal."))
    )
  )
  const bound = yield* fs.stat(socketPath).pipe(Effect.mapError(io))
  yield* Ref.set(identity, Option.getOrUndefined(bound.ino))
  yield* fs.chmod(socketPath, 0o600).pipe(Effect.mapError(io))
  yield* inspectSocket(options, socketPath)
  const answer = (socket: Socket.Socket) =>
    Effect.scoped(Effect.gen(function*() {
      const reader = yield* socket.reader
      const writer = yield* socket.writer
      if ((yield* readLine(reader)) !== "mint") return
      yield* listening
      const url = yield* mintBootstrapUrl(session)
      yield* writer.write(`${JSON.stringify({ url })}\n`)
    })).pipe(
      Effect.timeout("5 seconds"),
      Effect.catch(() => Effect.logWarning("Alchemy console control exchange failed."))
    )
  yield* Effect.forkScoped(server.run(answer).pipe(Effect.mapError(io)))
})

/** Credential-bearing response: one loopback URL containing a single-use PairingCode. */
const LoginReply = Schema.fromJsonString(Schema.Struct({ url: Schema.String }))
const isCode = Schema.is(PairingCode)

/** None means no socket exists. Unsafe paths, stale sockets and bad replies propagate without starting another server. */
export const requestLoginUrl = Effect.fn("AlchemyConsole.requestLoginUrl")(function*(options: ControlOptions) {
  const socketPath = yield* location(options)
  if (!(yield* inspectDirectory(options, false))) return Option.none<string>()
  if ((yield* inspectSocket(options, socketPath)) === undefined) return Option.none<string>()
  const reply = yield* Effect.scoped(Effect.gen(function*() {
    const socket = yield* NodeSocket.makeNet({ path: socketPath })
    const reader = yield* socket.reader
    const writer = yield* socket.writer
    yield* writer.write("mint\n")
    return yield* readLine(reader)
  })).pipe(
    Effect.mapError(io),
    Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new ControlError({ reason: "timeout" })) })
  )
  const decoded = yield* Schema.decodeUnknownEffect(LoginReply)(reply).pipe(
    Effect.mapError(() => new ControlError({ reason: "invalid-reply" }))
  )
  if (!URL.canParse(decoded.url)) return yield* new ControlError({ reason: "invalid-reply" })
  const url = new URL(decoded.url)
  const origin = `http://127.0.0.1:${options.port}`
  const prefix = "#bootstrap_token="
  if (
    url.origin !== origin || url.pathname !== "/" || url.search !== "" || url.username !== "" ||
    url.password !== "" || !url.hash.startsWith(prefix) || !isCode(url.hash.slice(prefix.length))
  ) return yield* new ControlError({ reason: "invalid-reply" })
  return Option.some(decoded.url)
})
