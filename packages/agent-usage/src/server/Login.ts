/**
 * `agent-usage login`: a fresh one-time link from the running server, printed and optionally opened.
 *
 * The link goes to stdout and nowhere else, like the startup link: it is the credential. Failures
 * go to stderr as one sentence saying what to do, and end the process with a nonzero exit.
 *
 * @module
 */
import { Console, Effect, Runtime, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import {
  type LoginReplyInvalid,
  requestLoginUrl,
  type ServerNotRunning,
  type SocketPathTooLong,
  type SocketPathUnsafe,
  type SocketRefused
} from "./ControlSocket.js"

export type LoginFailure = ServerNotRunning | SocketPathTooLong | SocketPathUnsafe | SocketRefused | LoginReplyInvalid

/** The failure, already explained on stderr: the runtime exits nonzero without logging it again. */
export class LoginFailed extends Schema.TaggedError<LoginFailed>()("LoginFailed", {
  reason: Schema.String
}) {
  override readonly [Runtime.errorReported] = false
}

/** One sentence per failure, naming what to do about it. */
export const describeLoginFailure = (failure: LoginFailure): string => {
  switch (failure._tag) {
    case "ServerNotRunning":
      return "agent-usage is not running on this store. Start it with `agent-usage serve` (or its service), then run login again. If it is running, it is an older version without login: restart it."
    case "SocketPathUnsafe":
      return `agent-usage refused its control socket at ${failure.path}: ${failure.reason}. Remove it and restart the server.`
    case "SocketRefused":
      return `agent-usage's control socket at ${failure.path} could not be used (${failure.reason}).`
    case "SocketPathTooLong":
      return `${failure.message}, so this store has no login. Set AGENT_USAGE_HOME to a shorter path.`
    case "LoginReplyInvalid":
      return "the running agent-usage did not answer with a link; is it an older version? Restart it."
  }
}

/** The command that opens a URL in the default browser, where there is one this tool knows. */
export const openerFor = (platform: string): "open" | "xdg-open" | undefined =>
  platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : undefined

/**
 * Opens `url` in the browser. Reports a failure on stderr and carries on: the link is printed
 * either way. The link is on the opener's command line while it runs, visible to this machine's
 * process list for that moment; it is spent on first use and expires within the minute.
 */
const openInBrowser = Effect.fnUntraced(function*(url: string, platform: string) {
  const opener = openerFor(platform)
  if (opener === undefined) {
    return yield* Console.error(`agent-usage: cannot open a browser on ${platform}; open the link above.`)
  }
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  // In this process's group, not one of its own: the opener's group is killed when it is reaped,
  // which would take the browser it just started with it. Its output is not ours to hold open
  // either: the browser inherits it and would keep login waiting for as long as it runs.
  const opening = ChildProcess.make(opener, [url], {
    detached: false,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore"
  })
  const code = yield* spawner.exitCode(opening).pipe(Effect.result)
  if (code._tag === "Failure" || code.success !== 0) {
    yield* Console.error(`agent-usage: ${opener} could not open the link; open it yourself.`)
  }
})

/** Explains `failure` on stderr, then fails without the runtime reporting it again. */
const reported = (sentence: string, reason: string) =>
  Console.error(`agent-usage: ${sentence}`).pipe(Effect.andThen(Effect.fail(new LoginFailed({ reason }))))

/**
 * Reads the store directory from `config`, asks the server running there for a link, prints it, and
 * opens it when asked. Every failure, an unreadable configuration included, goes to stderr only, so
 * stdout carries the link or nothing.
 */
export const login = Effect.fn("Login.login")(function*<E extends { readonly message: string }, R>(
  config: Effect.Effect<{ readonly storeDirectory: string }, E, R>,
  open: boolean,
  platform: string,
  self: number
) {
  const settings = yield* config.pipe(
    Effect.catch((error: E) => reported(`its configuration could not be read: ${error.message}`, "ConfigError"))
  )
  const url = yield* requestLoginUrl(settings.storeDirectory, self).pipe(
    Effect.catch((failure: LoginFailure) => reported(describeLoginFailure(failure), failure._tag))
  )
  yield* Console.log(url)
  if (open) yield* openInBrowser(url, platform)
})
