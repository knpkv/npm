/**
 * The control socket `agent-usage login` asks the running server for a fresh one-time link over.
 *
 * **Mental model**
 *
 * - **The store directory is the door.** The socket is `serve.sock` in the store directory, which
 *   the database layer keeps owner-only (`0700`); the socket itself is `0600`. Reaching it already
 *   proves the caller is the owner, so the request needs no credential of its own.
 * - **Nothing at the path is trusted.** A symlink, a file that is not a socket, or a socket another
 *   user owns is refused, by the server before binding and by `login` before connecting.
 * - **One server per store, held by a lock the kernel keeps.** Before anything else the server
 *   takes an exclusive SQLite lock on `serve.lock` in the store directory and keeps it for its life;
 *   the operating system drops it when the process ends, however it ends. A second server finds it
 *   taken and refuses to start. Holding the lock, the server knows any socket at the path is one a
 *   dead server left behind, so it removes it and binds; no probing, no race between servers.
 * - **Short paths only.** A Unix socket path is limited to about a hundred bytes. A store directory
 *   too deep for one still runs and still holds the lock, without `login`, and says so.
 * - **One question, one answer.** The client sends `mint`; once the HTTP listener is up, the server
 *   mints a link through the same path as the startup link (one use, one minute) and replies with it
 *   as one JSON line. Or it sends `limits`, and the server replies with this Machine's latest limits
 *   ({@link LimitsNow}) once its store is open. Both sides give up after {@link EXCHANGE_DEADLINE}.
 *
 * @module
 */
import { NodeSocket, NodeSocketServer } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { isLoopbackHostname, type OwnerSessionService } from "@knpkv/browser-pairing/owner-session"
import { PairingCode } from "@knpkv/browser-pairing/schema"
import { Duration, Effect, FileSystem, Option, Path, Predicate, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type { Socket, SocketServer } from "effect/socket"
import { prepareStoreDirectory } from "../core/Database.js"
import { LimitsNow } from "../shared/contracts.js"
import { mintBootstrapUrl } from "./OwnerSession.js"

export const SOCKET_FILE = "serve.sock"
export const LOCK_FILE = "serve.lock"

/**
 * The longest socket path, in bytes, that binds everywhere this runs: macOS holds 104 bytes
 * including the terminating NUL, Linux 108.
 */
export const SOCKET_PATH_LIMIT = 103

/** How long either side waits for the other before giving up on one exchange. */
export const EXCHANGE_DEADLINE = Duration.seconds(5)

/** No server is listening on this store: start `agent-usage serve`. */
export class ServerNotRunning extends Schema.TaggedError<ServerNotRunning>()("ServerNotRunning", {
  path: Schema.String
}) {
  override get message() {
    return `no agent-usage server is listening at ${this.path}`
  }
}

/** A server already runs on this store; a second one would fight it for the store. */
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

/** The socket or lock is there but could not be used: no permission, no answer in time, or another failure. */
export class SocketRefused extends Schema.TaggedError<SocketRefused>()("SocketRefused", {
  path: Schema.String,
  reason: Schema.String
}) {
  override get message() {
    return `the control socket at ${this.path} could not be used (${this.reason})`
  }
}

/** The store directory is too deep for a Unix socket path, so this store has no `login`. */
export class SocketPathTooLong extends Schema.TaggedError<SocketPathTooLong>()("SocketPathTooLong", {
  path: Schema.String,
  bytes: Schema.Number
}) {
  override get message() {
    return `the control socket path ${this.path} is ${this.bytes} bytes, over the ${SOCKET_PATH_LIMIT}-byte limit for a Unix socket`
  }
}

/** The server could not read its limits, or answered with something that is not them. */
export class LimitsReplyInvalid extends Schema.TaggedError<LimitsReplyInvalid>()("LimitsReplyInvalid", {
  reply: Schema.String
}) {}

/** The server answered with something that is not a link. */
export class LoginReplyInvalid extends Schema.TaggedError<LoginReplyInvalid>()("LoginReplyInvalid", {
  reply: Schema.String
}) {}

const isPairingCode = Schema.is(PairingCode)

/**
 * A sign-in link as this server mints them: plain HTTP, a loopback host, and in the fragment a code
 * of the shape the page will accept.
 */
const isLoginUrl = (value: string): boolean => {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  const prefix = "#bootstrap_token="
  return url.protocol === "http:" && isLoopbackHostname(url.hostname) && url.pathname === "/" &&
    url.search === "" && url.hash.startsWith(prefix) && isPairingCode(url.hash.slice(prefix.length))
}

const LoginUrl = Schema.String.check(
  Schema.makeFilter(isLoginUrl, { expected: "a loopback link carrying a one-time code" })
)
const LoginReply = Schema.fromJsonString(Schema.Struct({ url: LoginUrl }))
const encodeReply = Schema.encodeSync(LoginReply)
const decodeReply = Schema.decodeUnknownOption(LoginReply)
const LimitsReply = Schema.fromJsonString(LimitsNow)
const encodeLimits = Schema.encodeSync(LimitsReply)
const decodeLimits = Schema.decodeUnknownOption(LimitsReply)

/** A Node system error, as far as this module reads one. */
const Errno = Schema.Struct({ code: Schema.String })
const decodeErrno = Schema.decodeUnknownOption(Errno)

/** The system error code (`ECONNREFUSED`, `EACCES`, `EEXIST`) behind a filesystem or socket failure. */
const errnoOf = (
  failure: PlatformError | Socket.SocketError | SocketServer.SocketServerError
): string | undefined => {
  const cause = failure._tag === "PlatformError" ? failure.cause : failure.reason.cause
  return Option.getOrUndefined(Option.map(decodeErrno(cause), (errno) => errno.code))
}

/** `readlink` on something that is not a link fails with EINVAL; nothing else means "not a link". */
const isNotALink = (error: PlatformError): boolean => errnoOf(error) === "EINVAL"

/** The socket path for a store, refused when it is too long to bind. */
const socketPathFor = Effect.fnUntraced(function*(directory: string) {
  const path = yield* Path.Path
  const socketPath = path.join(directory, SOCKET_FILE)
  const bytes = new TextEncoder().encode(socketPath).byteLength
  if (bytes > SOCKET_PATH_LIMIT) return yield* new SocketPathTooLong({ path: socketPath, bytes })
  return socketPath
})

/**
 * What is at `socketPath`: nothing, or a socket owned by `self` (this process's user id) in a store
 * directory `self` also owns. Anything else is refused: another account could have bound it.
 */
const inspect = Effect.fnUntraced(function*(directory: string, socketPath: string, self: number) {
  const fs = yield* FileSystem.FileSystem
  const unsafe = (reason: string) => new SocketPathUnsafe({ path: socketPath, reason })
  const link = yield* Effect.result(fs.readLink(socketPath))
  if (link._tag === "Success") return yield* unsafe("it is a symbolic link")
  if (link.failure.reason._tag === "NotFound") return undefined
  if (!isNotALink(link.failure)) return yield* unsafe(`it could not be inspected (${link.failure.reason._tag})`)
  const [info, store] = yield* Effect.all([fs.stat(socketPath), fs.stat(directory)]).pipe(
    Effect.mapError((error) => unsafe(`it could not be inspected (${error.reason._tag})`))
  )
  if (Option.getOrUndefined(store.uid) !== self) return yield* unsafe("another user owns the store directory")
  if (info.type !== "Socket") return yield* unsafe(`it is a ${info.type}, not a socket`)
  if (Option.getOrUndefined(info.uid) !== self) return yield* unsafe("another user owns it")
  return { inode: Option.getOrUndefined(info.ino) }
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

/**
 * One connection: `mint` answered with a fresh link, `limits` with this Machine's latest limits,
 * anything else with an error. A limits read that fails is answered with an error line.
 */
const answer = <E>(
  secrets: OwnerSessionService,
  listening: Effect.Effect<void>,
  limits: Effect.Effect<LimitsNow, E>
) =>
(socket: Socket.Socket) =>
  Effect.scoped(Effect.gen(function*() {
    const reader = yield* socket.reader
    const write = yield* socket.writer
    const request = (yield* readLine(reader)).trim()
    if (request === "limits") {
      const read = yield* Effect.result(limits)
      return yield* write.write(
        read._tag === "Success" ? `${encodeLimits(read.success)}\n` : "{\"error\":\"limits unavailable\"}\n"
      )
    }
    if (request !== "mint") return yield* write.write("{\"error\":\"unknown request\"}\n")
    // Never before the HTTP listener is up: a code minted earlier would be one nobody could spend.
    yield* listening
    const url = yield* mintBootstrapUrl(secrets)
    yield* write.write(`${encodeReply({ url })}\n`)
    // One client's exchange failing (it hung up, or missed the deadline) must not stop the socket; log it.
  })).pipe(
    Effect.timeout(EXCHANGE_DEADLINE),
    Effect.ignore({ log: "Warn", message: "agent-usage control socket: an exchange failed" })
  )

/** A control socket given no limits to read: every `limits` request is answered with an error. */
class LimitsNotServed extends Schema.TaggedError<LimitsNotServed>()("LimitsNotServed", {}) {}
const noLimits: Effect.Effect<LimitsNow, LimitsNotServed> = Effect.fail(new LimitsNotServed())

/**
 * Takes the store's exclusive lock for the life of the scope: an SQLite database opened in exclusive
 * locking mode and written once, so its lock is held until the connection closes or the process
 * ends. Fails with {@link ServerAlreadyRunning} when another server holds it.
 */
const holdStoreLock = Effect.fnUntraced(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const lockPath = path.join(directory, LOCK_FILE)
  const link = yield* Effect.result(fs.readLink(lockPath))
  if (link._tag === "Success") return yield* new SocketPathUnsafe({ path: lockPath, reason: "it is a symbolic link" })
  const client = yield* SqliteClient.make({ filename: lockPath, disableWAL: true, busyTimeout: 0 })
  yield* Effect.all([
    client.unsafe("PRAGMA locking_mode = EXCLUSIVE"),
    client.unsafe("BEGIN EXCLUSIVE"),
    client.unsafe("COMMIT")
  ], { discard: true }).pipe(
    Effect.mapError((error) =>
      error.reason._tag === "LockTimeoutError"
        ? new ServerAlreadyRunning({ path: lockPath })
        : new SocketRefused({ path: lockPath, reason: error.reason._tag })
    )
  )
  yield* fs.chmod(lockPath, 0o600).pipe(
    Effect.mapError((error) => new SocketPathUnsafe({ path: lockPath, reason: error.reason._tag }))
  )
  // This process just created or opened it for writing: its owner is who this process runs as.
  const info = yield* fs.stat(lockPath).pipe(
    Effect.mapError((error) => new SocketPathUnsafe({ path: lockPath, reason: error.reason._tag }))
  )
  const self = Option.getOrUndefined(info.uid)
  if (self === undefined) return yield* new SocketPathUnsafe({ path: lockPath, reason: "it has no owner to compare" })
  return self
})

/**
 * Holds the store's lock and listens on `<directory>/serve.sock` for the life of the scope; returns
 * the socket path, or nothing (and logs why) when the path is too long for a Unix socket. Requests
 * wait for `listening` before a link is minted; a `limits` request runs `limits`. Fails with {@link ServerAlreadyRunning} when another
 * server runs on this store and {@link SocketPathUnsafe} when the path holds anything but this
 * user's socket.
 */
export const controlSocket = Effect.fn("ControlSocket.listen")(function*<E = LimitsNotServed>(
  directory: string,
  secrets: OwnerSessionService,
  listening: Effect.Effect<void>,
  limits?: Effect.Effect<LimitsNow, E>
) {
  const fs = yield* FileSystem.FileSystem
  // The directory must be the store's, checked, before its lock is taken inside it.
  yield* prepareStoreDirectory(directory)
  const self = yield* holdStoreLock(directory)
  const located = yield* Effect.result(socketPathFor(directory))
  if (located._tag === "Failure") {
    yield* Effect.logWarning(`agent-usage login is unavailable: ${located.failure.message}`)
    return undefined
  }
  const socketPath = located.success
  // With the lock held, a socket here is one a server that died left behind.
  const found = yield* inspect(directory, socketPath, self)
  if (found !== undefined) {
    yield* fs.remove(socketPath).pipe(
      Effect.mapError((error) => new SocketPathUnsafe({ path: socketPath, reason: error.reason._tag }))
    )
  }
  const server = yield* NodeSocketServer.make({ path: socketPath }).pipe(
    Effect.mapError((error) => new SocketRefused({ path: socketPath, reason: errnoOf(error) ?? error.reason._tag }))
  )
  // best-effort: a socket file left behind is found and removed by the next start (above).
  yield* Effect.addFinalizer(() => fs.remove(socketPath).pipe(Effect.ignore))
  yield* fs.chmod(socketPath, 0o600).pipe(
    Effect.mapError((error) => new SocketPathUnsafe({ path: socketPath, reason: error.reason._tag }))
  )
  if ((yield* inspect(directory, socketPath, self)) === undefined) {
    return yield* new SocketPathUnsafe({ path: socketPath, reason: "it vanished after binding" })
  }
  yield* Effect.forkScoped(server.run(answer<E | LimitsNotServed>(secrets, listening, limits ?? noLimits)))
  return socketPath
})

/** Sends one request line to the server on this store and returns its one reply line, trimmed. */
const exchange = Effect.fnUntraced(function*(directory: string, self: number, request: "mint" | "limits") {
  const socketPath = yield* socketPathFor(directory)
  const found = yield* inspect(directory, socketPath, self)
  if (found === undefined) return yield* new ServerNotRunning({ path: socketPath })
  const reply = yield* Effect.scoped(Effect.gen(function*() {
    const socket = yield* NodeSocket.makeNet({ path: socketPath })
    const reader = yield* socket.reader
    const write = yield* socket.writer
    yield* write.write(`${request}\n`)
    return yield* readLine(reader)
  })).pipe(
    Effect.mapError((error) => {
      const code = errnoOf(error)
      return code === "ECONNREFUSED" || code === "ENOENT"
        ? new ServerNotRunning({ path: socketPath })
        : new SocketRefused({ path: socketPath, reason: code ?? error.reason._tag })
    }),
    Effect.timeoutOrElse({
      duration: EXCHANGE_DEADLINE,
      orElse: () => Effect.fail(new SocketRefused({ path: socketPath, reason: "the server did not answer in time" }))
    })
  )
  return reply.trim()
})

/**
 * Asks the server running on this store for a fresh one-time link, trusting only a socket owned by
 * `self`, the user id this process runs as. Fails with
 * {@link ServerNotRunning} when nothing listens, {@link SocketPathTooLong} when the store has no
 * control socket, {@link SocketPathUnsafe} when the path is not this user's socket,
 * {@link SocketRefused} when the socket may not be used or does not answer within
 * {@link EXCHANGE_DEADLINE}, and {@link LoginReplyInvalid} when the answer is not a link.
 */
export const requestLoginUrl = Effect.fn("ControlSocket.requestLoginUrl")(function*(directory: string, self: number) {
  const reply = yield* exchange(directory, self, "mint")
  const decoded = decodeReply(reply)
  if (Option.isNone(decoded)) return yield* new LoginReplyInvalid({ reply: reply.slice(0, 200) })
  return decoded.value.url
})

/**
 * Asks the server running on this store for this Machine's latest limits, with the same trust and
 * failures as {@link requestLoginUrl}; {@link LimitsReplyInvalid} when the server could not read
 * them (or is a version that does not know the request).
 */
export const requestLimits = Effect.fn("ControlSocket.requestLimits")(function*(directory: string, self: number) {
  const reply = yield* exchange(directory, self, "limits")
  const decoded = decodeLimits(reply)
  if (Option.isNone(decoded)) return yield* new LimitsReplyInvalid({ reply: reply.slice(0, 200) })
  return decoded.value
})
