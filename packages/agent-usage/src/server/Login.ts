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
  type SocketPathUnsafe,
  type SocketRefused
} from "./ControlSocket.js"

export type LoginFailure = ServerNotRunning | SocketPathUnsafe | SocketRefused | LoginReplyInvalid

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
      return "agent-usage is not running on this store. Start it with `agent-usage serve` (or its service), then run login again."
    case "SocketPathUnsafe":
      return `agent-usage refused its control socket at ${failure.path}: ${failure.reason}. Remove it and restart the server.`
    case "SocketRefused":
      return `agent-usage's control socket at ${failure.path} could not be used (${failure.reason}).`
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
  const code = yield* spawner.exitCode(ChildProcess.make(opener, [url])).pipe(Effect.result)
  if (code._tag === "Failure" || code.success !== 0) {
    yield* Console.error(`agent-usage: ${opener} could not open the link; open it yourself.`)
  }
})

/** Asks the server running on `storeDirectory` for a link, prints it, and opens it when asked. */
export const login = Effect.fn("Login.login")(function*(storeDirectory: string, open: boolean, platform: string) {
  const url = yield* requestLoginUrl(storeDirectory).pipe(
    Effect.catch((failure: LoginFailure) =>
      Console.error(`agent-usage: ${describeLoginFailure(failure)}`).pipe(
        Effect.andThen(Effect.fail(new LoginFailed({ reason: failure._tag })))
      )
    )
  )
  yield* Console.log(url)
  if (open) yield* openInBrowser(url, platform)
})
