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
 *   ({@link LimitsNow}) once its store is open; or `usage <preset> <time zone>`, and it replies with
 *   this Machine's usage over that range ({@link UsageNow}). Both sides give up after
 *   {@link EXCHANGE_DEADLINE}.
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
import type { UnknownTimeZone } from "../core/Report.js"
import { LimitsNow, UsageNow, UsagePreset } from "../shared/contracts.js"
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

/** The server is a version without the `limits` request: upgrade or restart it. */
export class LimitsNotSupported extends Schema.TaggedError<LimitsNotSupported>()("LimitsNotSupported", {
  path: Schema.String
}) {}

/** The server knows the request but could not read its store; its log says why. */
export class LimitsUnavailable extends Schema.TaggedError<LimitsUnavailable>()("LimitsUnavailable", {
  path: Schema.String
}) {}

/** The server answered with something that is neither limits nor one of its error lines. */
export class LimitsReplyInvalid extends Schema.TaggedError<LimitsReplyInvalid>()("LimitsReplyInvalid", {
  reply: Schema.String
}) {}

/** The server is a version without the `usage` request: upgrade or restart it. */
export class UsageNotSupported extends Schema.TaggedError<UsageNotSupported>()("UsageNotSupported", {
  path: Schema.String
}) {}

/** The server knows the request but could not read its store; its log says why. */
export class UsageUnavailable extends Schema.TaggedError<UsageUnavailable>()("UsageUnavailable", {
  path: Schema.String
}) {}

/**
 * The usage request was refused: a range or a time zone the server does not know, or a line that is
 * not `usage <range> <zone>` (an empty zone, or one with whitespace, is refused before it is sent).
 */
export class UsageRequestRefused extends Schema.TaggedError<UsageRequestRefused>()("UsageRequestRefused", {
  refused: Schema.Literals(["range", "time zone", "malformed"]),
  preset: Schema.String,
  timeZone: Schema.String
}) {}

/** The server answered with something that is neither usage nor one of its error lines. */
export class UsageReplyInvalid extends Schema.TaggedError<UsageReplyInvalid>()("UsageReplyInvalid", {
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
const UsageReply = Schema.fromJsonString(UsageNow)
const encodeUsage = Schema.encodeSync(UsageReply)
const decodeUsage = Schema.decodeUnknownOption(UsageReply)
const isUsagePreset = Schema.is(UsagePreset)
const UNKNOWN_REQUEST = "unknown request"
const LIMITS_UNAVAILABLE = "limits unavailable"
const USAGE_UNAVAILABLE = "usage unavailable"
const BAD_REQUEST = "bad request"
const UNKNOWN_RANGE = "unknown range"
const UNKNOWN_TIME_ZONE = "unknown time zone"
const errorLine = (error: string): string => `${JSON.stringify({ error })}\n`
const decodeErrorLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Literals([
        UNKNOWN_REQUEST,
        LIMITS_UNAVAILABLE,
        USAGE_UNAVAILABLE,
        BAD_REQUEST,
        UNKNOWN_RANGE,
        UNKNOWN_TIME_ZONE
      ])
    })
  )
)

/** What the socket answers from the store, once it is open. */
export interface ControlReaders<E> {
  readonly limits: Effect.Effect<LimitsNow, E>
  readonly usage: (preset: UsagePreset, timeZone: string) => Effect.Effect<UsageNow, E | UnknownTimeZone>
}

/**
 * A `usage` request line: the word, a preset and an IANA zone, separated by single spaces. Any other
 * line starting with `usage` is `malformed`, so a mistake is never answered as an unknown request.
 */
const usageRequest = (
  request: string
): { readonly preset: string; readonly timeZone: string } | "malformed" | undefined => {
  const [word, preset, timeZone, ...rest] = request.split(" ")
  if (word !== "usage") return undefined
  if (preset === undefined || timeZone === undefined || timeZone === "" || rest.length > 0) return "malformed"
  return { preset, timeZone }
}

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
 * `usage` with its usage over a range, anything else with an error. A read that fails is answered
 * with an error line; a range or zone the server does not know, with `bad request`.
 */
const answer = <E>(
  secrets: OwnerSessionService,
  listening: Effect.Effect<void>,
  readers: ControlReaders<E>
) =>
(socket: Socket.Socket) =>
  Effect.scoped(Effect.gen(function*() {
    const reader = yield* socket.reader
    const write = yield* socket.writer
    const request = (yield* readLine(reader)).trim()
    if (request === "limits") {
      const read = yield* Effect.result(readers.limits)
      if (read._tag === "Success") return yield* write.write(`${encodeLimits(read.success)}\n`)
      // The client only learns that the read failed; why stays in this server's log.
      yield* Effect.logWarning("agent-usage control socket: reading limits failed", read.failure)
      return yield* write.write(errorLine(LIMITS_UNAVAILABLE))
    }
    const usage = usageRequest(request)
    if (usage === "malformed") return yield* write.write(errorLine(BAD_REQUEST))
    if (usage !== undefined) {
      if (!isUsagePreset(usage.preset)) return yield* write.write(errorLine(UNKNOWN_RANGE))
      const read = yield* Effect.result(readers.usage(usage.preset, usage.timeZone))
      if (read._tag === "Success") return yield* write.write(`${encodeUsage(read.success)}\n`)
      if (Predicate.isTagged(read.failure, "UnknownTimeZone")) return yield* write.write(errorLine(UNKNOWN_TIME_ZONE))
      yield* Effect.logWarning("agent-usage control socket: reading usage failed", read.failure)
      return yield* write.write(errorLine(USAGE_UNAVAILABLE))
    }
    if (request !== "mint") return yield* write.write(errorLine(UNKNOWN_REQUEST))
    // Never before the HTTP listener is up: a code minted earlier would be one nobody could spend.
    yield* listening
    const url = yield* mintBootstrapUrl(secrets)
    yield* write.write(`${encodeReply({ url })}\n`)
    // One client's exchange failing (it hung up, or missed the deadline) must not stop the socket; log it.
  })).pipe(
    Effect.timeout(EXCHANGE_DEADLINE),
    Effect.ignore({ log: "Warn", message: "agent-usage control socket: an exchange failed" })
  )

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
 * wait for `listening` before a link is minted; `limits` and `usage` requests run their `readers`.
 * Fails with {@link ServerAlreadyRunning} when another
 * server runs on this store and {@link SocketPathUnsafe} when the path holds anything but this
 * user's socket.
 */
export const controlSocket = Effect.fn("ControlSocket.listen")(function*<E>(
  directory: string,
  secrets: OwnerSessionService,
  listening: Effect.Effect<void>,
  readers: ControlReaders<E>
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
  yield* Effect.forkScoped(server.run(answer(secrets, listening, readers)))
  return socketPath
})

/** Sends one request line to the server on this store and returns its socket path and one reply line, trimmed. */
const exchange = Effect.fnUntraced(function*(directory: string, self: number, request: string) {
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
  return { socketPath, reply: reply.trim() }
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
  const { reply } = yield* exchange(directory, self, "mint")
  const decoded = decodeReply(reply)
  if (Option.isNone(decoded)) return yield* new LoginReplyInvalid({ reply: reply.slice(0, 200) })
  return decoded.value.url
})

/**
 * Asks the server running on this store for this Machine's latest limits, with the same trust and
 * failures as {@link requestLoginUrl}; {@link LimitsNotSupported} when the server is a version
 * without the request, {@link LimitsUnavailable} when it could not read its store, and
 * {@link LimitsReplyInvalid} for any other answer.
 */
export const requestLimits = Effect.fn("ControlSocket.requestLimits")(function*(directory: string, self: number) {
  const { reply, socketPath } = yield* exchange(directory, self, "limits")
  const decoded = decodeLimits(reply)
  if (Option.isSome(decoded)) return decoded.value
  const error = decodeErrorLine(reply)
  if (Option.isSome(error)) {
    return yield* error.value.error === UNKNOWN_REQUEST
      ? new LimitsNotSupported({ path: socketPath })
      : new LimitsUnavailable({ path: socketPath })
  }
  return yield* new LimitsReplyInvalid({ reply: reply.slice(0, 200) })
})

/**
 * Asks the server running on this store for this Machine's usage over `preset`, in periods local to
 * `timeZone`, with the same trust and failures as {@link requestLoginUrl}; {@link UsageNotSupported}
 * when the server is a version without the request, {@link UsageRequestRefused} (naming what) when
 * it does not know the range or the zone or the request is malformed, {@link UsageUnavailable} when it could not read its store, and
 * {@link UsageReplyInvalid} for any other answer.
 */
export const requestUsage = Effect.fn("ControlSocket.requestUsage")(function*(
  directory: string,
  self: number,
  preset: UsagePreset,
  timeZone: string
) {
  // One line, three words: an empty zone, or one with a space or newline, could only be a different request.
  if (timeZone === "" || /\s/u.test(timeZone)) {
    return yield* new UsageRequestRefused({ refused: "malformed", preset, timeZone })
  }
  const { reply, socketPath } = yield* exchange(directory, self, `usage ${preset} ${timeZone}`)
  const decoded = decodeUsage(reply)
  if (Option.isSome(decoded)) return decoded.value
  const error = decodeErrorLine(reply)
  if (Option.isSome(error)) {
    switch (error.value.error) {
      case UNKNOWN_REQUEST:
        return yield* new UsageNotSupported({ path: socketPath })
      case BAD_REQUEST:
        return yield* new UsageRequestRefused({ refused: "malformed", preset, timeZone })
      case UNKNOWN_RANGE:
        return yield* new UsageRequestRefused({ refused: "range", preset, timeZone })
      case UNKNOWN_TIME_ZONE:
        return yield* new UsageRequestRefused({ refused: "time zone", preset, timeZone })
      default:
        return yield* new UsageUnavailable({ path: socketPath })
    }
  }
  return yield* new UsageReplyInvalid({ reply: reply.slice(0, 200) })
})
