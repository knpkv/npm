/**
 * The control socket `agent-usage login` asks the running server for a fresh one-time link over.
 *
 * **Mental model**
 *
 * - **The store directory is the door.** The socket is `serve.sock` in the store directory, which
 *   the database layer keeps owner-only (`0700`); the socket itself is `0600`. Reaching it already
 *   proves the caller is the owner, so the request needs no credential of its own.
 * - **Nothing at the path is trusted.** A symlink, a file that is not a socket, or a socket another
 *   user owns is refused, by the server before binding and by `login` before connecting. A socket
 *   nobody answers is a server that died: the next server replaces it. One that answers means a
 *   server is running on this store already, and a second one refuses to start.
 * - **One question, one answer.** The client sends `mint`; the server mints a link through the same
 *   path as the startup link (one use, one minute) and replies with it as one JSON line.
 *
 * @module
 */
import { NodeSocket, NodeSocketServer } from "@effect/platform-node"
import { Effect, FileSystem, Option, Path, Predicate, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type { Socket, SocketServer } from "effect/socket"
import { mintBootstrapUrl, type OwnerSessionSecretsContract } from "./OwnerSession.js"

export const SOCKET_FILE = "serve.sock"

/** No server is listening on this store: start `agent-usage serve`. */
export class ServerNotRunning extends Schema.TaggedError<ServerNotRunning>()("ServerNotRunning", {
  path: Schema.String
}) {
  override get message() {
    return `no agent-usage server is listening at ${this.path}`
  }
}

/** A server already answers on this store's socket; a second one would fight it for the store. */
export class ServerAlreadyRunning extends Schema.TaggedError<ServerAlreadyRunning>()("ServerAlreadyRunning", {
  path: Schema.String
}) {
  override get message() {
    return `agent-usage is already running on this store (${this.path}); use \`agent-usage login\` to get in`
  }
}

/** Something at the socket path is not this user's socket: a symlink, a plain file, a foreign owner. */
export class SocketPathUnsafe extends Schema.TaggedError<SocketPathUnsafe>()("SocketPathUnsafe", {
  path: Schema.String,
  reason: Schema.String
}) {
  override get message() {
    return `refusing the control socket at ${this.path}: ${this.reason}`
  }
}

/** The socket is there but this process may not use it, or the connection failed for another reason. */
export class SocketRefused extends Schema.TaggedError<SocketRefused>()("SocketRefused", {
  path: Schema.String,
  reason: Schema.String
}) {
  override get message() {
    return `the control socket at ${this.path} could not be used (${this.reason})`
  }
}

/** The server answered with something that is not a link. */
export class LoginReplyInvalid extends Schema.TaggedError<LoginReplyInvalid>()("LoginReplyInvalid", {
  reply: Schema.String
}) {}

const LoginReply = Schema.fromJsonString(Schema.Struct({ url: Schema.String }))
const encodeReply = Schema.encodeSync(LoginReply)
const decodeReply = Schema.decodeUnknownOption(LoginReply)

/** A Node system error, as far as this module reads one. */
const Errno = Schema.Struct({ code: Schema.String })
const decodeErrno = Schema.decodeUnknownOption(Errno)

/** The system error code (`ECONNREFUSED`, `EACCES`, `EINVAL`) behind a filesystem or socket failure. */
const errnoOf = (
  failure: PlatformError | Socket.SocketError | SocketServer.SocketServerError
): string | undefined => {
  const cause = failure._tag === "PlatformError" ? failure.cause : failure.reason.cause
  return Option.getOrUndefined(Option.map(decodeErrno(cause), (errno) => errno.code))
}

/** `readlink` on something that is not a link fails with EINVAL; nothing else means "not a link". */
const isNotALink = (error: PlatformError): boolean => errnoOf(error) === "EINVAL"

/**
 * What is at the socket path: nothing, or this user's socket. Anything else is refused; the owner
 * must match the store directory's, which only its owner can write into.
 */
const inspect = Effect.fnUntraced(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const socketPath = path.join(directory, SOCKET_FILE)
  const unsafe = (reason: string) => new SocketPathUnsafe({ path: socketPath, reason })
  const link = yield* Effect.result(fs.readLink(socketPath))
  if (link._tag === "Success") return yield* unsafe("it is a symbolic link")
  if (link.failure.reason._tag === "NotFound") return { socketPath, present: false }
  if (!isNotALink(link.failure)) return yield* unsafe(`it could not be inspected (${link.failure.reason._tag})`)
  const [info, owner] = yield* Effect.all([fs.stat(socketPath), fs.stat(directory)]).pipe(
    Effect.mapError((error) => unsafe(`it could not be inspected (${error.reason._tag})`))
  )
  if (info.type !== "Socket") return yield* unsafe(`it is a ${info.type}, not a socket`)
  const uid = Option.getOrUndefined(info.uid)
  if (uid === undefined || uid !== Option.getOrUndefined(owner.uid)) {
    return yield* unsafe("another user owns it")
  }
  return { socketPath, present: true }
})

/**
 * Reads from an open connection until a full line arrives or the peer closes it. The reader must be
 * acquired before anything is written: acquiring it is what opens the connection.
 */
const readLine = (reader: Socket.Reader) =>
  Effect.gen(function*() {
    const decoder = new TextDecoder()
    let text = ""
    while (!text.includes("\n")) {
      const batch = yield* Effect.result(reader.pull)
      if (batch._tag === "Failure") {
        if (batch.failure.reason._tag === "SocketCloseError") return text
        return yield* batch.failure
      }
      for (const chunk of batch.success) text += Predicate.isString(chunk) ? chunk : decoder.decode(chunk)
    }
    return text
  })

/** One connection: a `mint` request answered with a fresh link, anything else with an error. */
const answer = (secrets: OwnerSessionSecretsContract) => (socket: Socket.Socket) =>
  Effect.scoped(Effect.gen(function*() {
    const reader = yield* socket.reader
    const write = yield* socket.writer
    const request = yield* readLine(reader)
    if (request.trim() !== "mint") return yield* write.write("{\"error\":\"unknown request\"}\n")
    const url = yield* mintBootstrapUrl(secrets)
    yield* write.write(`${encodeReply({ url })}\n`)
  })).pipe(Effect.ignore)

/**
 * Listens on `<directory>/serve.sock` for the life of the scope, then removes it. Fails with
 * {@link ServerAlreadyRunning} when another server answers there, and {@link SocketPathUnsafe}
 * when the path holds anything but this user's socket.
 */
export const controlSocket = Effect.fn("ControlSocket.listen")(function*(
  directory: string,
  secrets: OwnerSessionSecretsContract
) {
  const fs = yield* FileSystem.FileSystem
  const found = yield* inspect(directory)
  if (found.present) {
    const alive = yield* Effect.scoped(
      NodeSocket.makeNet({ path: found.socketPath }).pipe(
        Effect.flatMap((socket) => Effect.scoped(socket.reader)),
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false))
      )
    )
    if (alive) return yield* new ServerAlreadyRunning({ path: found.socketPath })
    // Nobody answers: a server that died left it behind.
    yield* fs.remove(found.socketPath).pipe(
      Effect.mapError((error) => new SocketPathUnsafe({ path: found.socketPath, reason: error.reason._tag }))
    )
  }
  const server = yield* NodeSocketServer.make({ path: found.socketPath }).pipe(
    Effect.mapError((error) =>
      new SocketRefused({ path: found.socketPath, reason: errnoOf(error) ?? error.reason._tag })
    )
  )
  yield* Effect.addFinalizer(() => fs.remove(found.socketPath).pipe(Effect.ignore))
  yield* fs.chmod(found.socketPath, 0o600).pipe(
    Effect.mapError((error) => new SocketPathUnsafe({ path: found.socketPath, reason: error.reason._tag }))
  )
  // Bound and restricted: check that what is there now is still our socket.
  const bound = yield* inspect(directory)
  if (!bound.present) {
    return yield* new SocketPathUnsafe({ path: found.socketPath, reason: "it vanished after binding" })
  }
  yield* Effect.forkScoped(server.run(answer(secrets)))
  return found.socketPath
})

/**
 * Asks the server running on this store for a fresh one-time link. Fails with
 * {@link ServerNotRunning} when nothing listens, {@link SocketPathUnsafe} when the path is not this
 * user's socket, {@link SocketRefused} when the socket may not be used, and
 * {@link LoginReplyInvalid} when the answer is not a link.
 */
export const requestLoginUrl = Effect.fn("ControlSocket.requestLoginUrl")(function*(directory: string) {
  const found = yield* inspect(directory)
  if (!found.present) return yield* new ServerNotRunning({ path: found.socketPath })
  const reply = yield* Effect.scoped(Effect.gen(function*() {
    const socket = yield* NodeSocket.makeNet({ path: found.socketPath })
    const reader = yield* socket.reader
    const write = yield* socket.writer
    yield* write.write("mint\n")
    return yield* readLine(reader)
  })).pipe(
    Effect.mapError((error) => {
      const code = errnoOf(error)
      return code === "ECONNREFUSED" || code === "ENOENT"
        ? new ServerNotRunning({ path: found.socketPath })
        : new SocketRefused({ path: found.socketPath, reason: code ?? error.reason._tag })
    })
  )
  const decoded = decodeReply(reply.trim())
  if (Option.isNone(decoded)) return yield* new LoginReplyInvalid({ reply: reply.trim().slice(0, 200) })
  return decoded.value.url
})
