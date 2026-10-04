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
 * - **One server per store, claimed atomically.** The server binds a private name first and then
 *   hard-links it to `serve.sock`, which fails if anything is already there, so two servers cannot
 *   both hold the path. A socket that refuses connections is a server that died: it is moved aside
 *   and removed only if it is still that same socket, so a racing server's fresh socket is never
 *   deleted. A socket that answers, or that cannot be probed, is left alone and the second server
 *   refuses to start. On shutdown the path is removed only while it is still this server's.
 * - **Short paths only.** A Unix socket path is limited to about a hundred bytes. A store directory
 *   too deep for one still runs, without `login`, and says so.
 * - **One question, one answer.** The client sends `mint`; the server mints a link through the same
 *   path as the startup link (one use, one minute) and replies with it as one JSON line. Both sides
 *   give up after {@link EXCHANGE_DEADLINE}.
 *
 * @module
 */
import { NodeSocket, NodeSocketServer } from "@effect/platform-node"
import { Duration, Effect, FileSystem, Option, Path, Predicate, Random, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type { Socket, SocketServer } from "effect/socket"
import { isLoopbackHostname, mintBootstrapUrl, type OwnerSessionSecretsContract } from "./OwnerSession.js"

export const SOCKET_FILE = "serve.sock"

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

/** The socket is there but could not be used: no permission, no answer in time, or another failure. */
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

/** The server answered with something that is not a link. */
export class LoginReplyInvalid extends Schema.TaggedError<LoginReplyInvalid>()("LoginReplyInvalid", {
  reply: Schema.String
}) {}

/** A sign-in link as this server mints them: plain HTTP, a loopback host, the code in the fragment. */
const isLoginUrl = (value: string): boolean => {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return url.protocol === "http:" && isLoopbackHostname(url.hostname) && url.pathname === "/" &&
    url.search === "" && /^#bootstrap_token=[^&=#]+$/u.test(url.hash)
}

const LoginUrl = Schema.String.check(
  Schema.makeFilter(isLoginUrl, { expected: "a loopback link carrying a one-time code" })
)
const LoginReply = Schema.fromJsonString(Schema.Struct({ url: LoginUrl }))
const encodeReply = Schema.encodeSync(LoginReply)
const decodeReply = Schema.decodeUnknownOption(LoginReply)

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
 * What is at `socketPath`: nothing, or this user's socket and its inode. Anything else is refused;
 * the owner must match the store directory's, which only its owner can write into.
 */
const inspect = Effect.fnUntraced(function*(directory: string, socketPath: string) {
  const fs = yield* FileSystem.FileSystem
  const unsafe = (reason: string) => new SocketPathUnsafe({ path: socketPath, reason })
  const link = yield* Effect.result(fs.readLink(socketPath))
  if (link._tag === "Success") return yield* unsafe("it is a symbolic link")
  if (link.failure.reason._tag === "NotFound") return undefined
  if (!isNotALink(link.failure)) return yield* unsafe(`it could not be inspected (${link.failure.reason._tag})`)
  const [info, owner] = yield* Effect.all([fs.stat(socketPath), fs.stat(directory)]).pipe(
    Effect.mapError((error) => unsafe(`it could not be inspected (${error.reason._tag})`))
  )
  if (info.type !== "Socket") return yield* unsafe(`it is a ${info.type}, not a socket`)
  const uid = Option.getOrUndefined(info.uid)
  if (uid === undefined || uid !== Option.getOrUndefined(owner.uid)) return yield* unsafe("another user owns it")
  return { inode: Option.getOrUndefined(info.ino) }
})

/** The inode at `path`, or nothing there. */
const inodeAt = (fs: FileSystem.FileSystem, path: string): Effect.Effect<Option.Option<number>> =>
  fs.stat(path).pipe(
    Effect.map((info) => info.ino),
    Effect.catch(() => Effect.succeedNone)
  )

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
  })).pipe(Effect.timeout(EXCHANGE_DEADLINE), Effect.ignore)

/** Whether a server answers at a socket path: it does, it refuses (died), or the socket is gone. */
type Liveness = "alive" | "dead" | "gone"

const probe = (socketPath: string): Effect.Effect<Liveness, SocketRefused> =>
  Effect.scoped(
    NodeSocket.makeNet({ path: socketPath }).pipe(Effect.flatMap((socket) => Effect.scoped(socket.reader)))
  ).pipe(
    Effect.as<Liveness>("alive"),
    Effect.timeoutOrElse({
      duration: EXCHANGE_DEADLINE,
      orElse: () => Effect.fail(new SocketRefused({ path: socketPath, reason: "it did not answer in time" }))
    }),
    Effect.catchTag("SocketError", (error) => {
      const code = errnoOf(error)
      return code === "ECONNREFUSED"
        ? Effect.succeed<Liveness>("dead")
        : code === "ENOENT"
        ? Effect.succeed<Liveness>("gone")
        : Effect.fail(new SocketRefused({ path: socketPath, reason: code ?? error.reason._tag }))
    })
  )

/**
 * Removes the socket at `socketPath` only if it is still the dead one with `inode`: it is moved aside
 * first, which is atomic, and put back when it turns out to be a racing server's fresh socket.
 */
const reclaim = Effect.fnUntraced(function*(socketPath: string, aside: string, inode: number | undefined) {
  const fs = yield* FileSystem.FileSystem
  const moved = yield* Effect.result(fs.rename(socketPath, aside))
  if (moved._tag === "Failure") {
    if (moved.failure.reason._tag === "NotFound") return
    return yield* new SocketPathUnsafe({
      path: socketPath,
      reason: `it could not be moved (${moved.failure.reason._tag})`
    })
  }
  const movedInode = Option.getOrUndefined(yield* inodeAt(fs, aside))
  if (inode !== undefined && movedInode === inode) return yield* fs.remove(aside).pipe(Effect.ignore)
  yield* fs.link(aside, socketPath).pipe(Effect.ignore)
  yield* fs.remove(aside).pipe(Effect.ignore)
  return yield* new ServerAlreadyRunning({ path: socketPath })
})

/**
 * Hard-links the bound socket at `bound` to `socketPath`, reclaiming a dead socket there first.
 * Fails with {@link ServerAlreadyRunning} when another server holds the path.
 */
const claim = Effect.fnUntraced(function*(directory: string, socketPath: string, bound: string, aside: string) {
  const fs = yield* FileSystem.FileSystem
  for (let attempt = 0; attempt < 3; attempt++) {
    const linked = yield* Effect.result(fs.link(bound, socketPath))
    if (linked._tag === "Success") return
    if (errnoOf(linked.failure) !== "EEXIST") {
      return yield* new SocketRefused({
        path: socketPath,
        reason: errnoOf(linked.failure) ?? linked.failure.reason._tag
      })
    }
    const found = yield* inspect(directory, socketPath)
    if (found === undefined) continue
    const state = yield* probe(socketPath)
    if (state === "alive") return yield* new ServerAlreadyRunning({ path: socketPath })
    if (state === "dead") yield* reclaim(socketPath, aside, found.inode)
  }
  return yield* new ServerAlreadyRunning({ path: socketPath })
})

/**
 * Listens on `<directory>/serve.sock` for the life of the scope and returns its path, or returns
 * nothing (and logs why) when the path is too long for a Unix socket. Fails with
 * {@link ServerAlreadyRunning} when another server holds the path, {@link SocketPathUnsafe} when
 * it holds anything but this user's socket, and {@link SocketRefused} when a socket there cannot
 * be probed.
 */
export const controlSocket = Effect.fn("ControlSocket.listen")(function*(
  directory: string,
  secrets: OwnerSessionSecretsContract
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const located = yield* Effect.result(socketPathFor(directory))
  if (located._tag === "Failure") {
    yield* Effect.logWarning(`agent-usage login is unavailable: ${located.failure.message}`)
    return undefined
  }
  const socketPath = located.success
  // Refuse an unsafe path before binding anything next to it.
  yield* inspect(directory, socketPath)
  const suffix = (yield* Random.nextIntBetween(0, 0x7fffffff)).toString(36)
  // Shorter than `serve.sock`, so they fit wherever it does.
  const bound = path.join(directory, `.s${suffix}`)
  const aside = path.join(directory, `.r${suffix}`)
  const server = yield* NodeSocketServer.make({ path: bound }).pipe(
    Effect.mapError((error) => new SocketRefused({ path: bound, reason: errnoOf(error) ?? error.reason._tag }))
  )
  yield* Effect.addFinalizer(() => fs.remove(bound).pipe(Effect.ignore))
  yield* fs.chmod(bound, 0o600).pipe(
    Effect.mapError((error) => new SocketPathUnsafe({ path: bound, reason: error.reason._tag }))
  )
  const ours = yield* inspect(directory, bound)
  if (ours === undefined) return yield* new SocketPathUnsafe({ path: bound, reason: "it vanished after binding" })
  yield* claim(directory, socketPath, bound, aside)
  // Removed on shutdown only while the path is still this server's socket.
  yield* Effect.addFinalizer(() =>
    inodeAt(fs, socketPath).pipe(
      Effect.flatMap((inode) =>
        Option.isSome(inode) && inode.value === ours.inode ? fs.remove(socketPath).pipe(Effect.ignore) : Effect.void
      )
    )
  )
  yield* fs.remove(bound).pipe(Effect.ignore)
  yield* Effect.forkScoped(server.run(answer(secrets)))
  return socketPath
})

/**
 * Asks the server running on this store for a fresh one-time link. Fails with
 * {@link ServerNotRunning} when nothing listens, {@link SocketPathTooLong} when the store has no
 * control socket, {@link SocketPathUnsafe} when the path is not this user's socket,
 * {@link SocketRefused} when the socket may not be used or does not answer within
 * {@link EXCHANGE_DEADLINE}, and {@link LoginReplyInvalid} when the answer is not a link.
 */
export const requestLoginUrl = Effect.fn("ControlSocket.requestLoginUrl")(function*(directory: string) {
  const socketPath = yield* socketPathFor(directory)
  const found = yield* inspect(directory, socketPath)
  if (found === undefined) return yield* new ServerNotRunning({ path: socketPath })
  const reply = yield* Effect.scoped(Effect.gen(function*() {
    const socket = yield* NodeSocket.makeNet({ path: socketPath })
    const reader = yield* socket.reader
    const write = yield* socket.writer
    yield* write.write("mint\n")
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
  const decoded = decodeReply(reply.trim())
  if (Option.isNone(decoded)) return yield* new LoginReplyInvalid({ reply: reply.trim().slice(0, 200) })
  return decoded.value.url
})
