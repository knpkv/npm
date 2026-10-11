/**
 * `agent-usage login`: a fresh one-time link from the running server, printed and optionally opened.
 *
 * The link goes to stdout and nowhere else, like the startup link: it is the credential. Failures
 * go to stderr as one sentence saying what to do, and end the process with a nonzero exit.
 *
 * @module
 */
import { openBrowser } from "@knpkv/browser-pairing/launch"
import { Console, Effect, Option, Runtime, Schema } from "effect"
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

/** Explains `failure` on stderr, then fails without the runtime reporting it again. */
const reported = (sentence: string, reason: string) =>
  Console.error(`agent-usage: ${sentence}`).pipe(Effect.andThen(Effect.fail(new LoginFailed({ reason }))))

/** Read login configuration with the same stderr-only failure used by both commands. */
const loginSettings = Effect.fn("Login.settings")(function*<E extends { readonly message: string }, R>(
  config: Effect.Effect<{ readonly storeDirectory: string }, E, R>
) {
  return yield* config.pipe(
    Effect.catch((error: E) => reported(`its configuration could not be read: ${error.message}`, "ConfigError"))
  )
})

/**
 * Ask the running server for a fresh link. Only an absent listener returns None; configuration,
 * unsafe socket and exchange failures are explained on stderr and fail without starting a server.
 */
export const existingLoginUrl = Effect.fn("Login.existingLoginUrl")(
  function*<E extends { readonly message: string }, R>(
    config: Effect.Effect<{ readonly storeDirectory: string }, E, R>,
    self: number
  ) {
    const settings = yield* loginSettings(config)
    return yield* requestLoginUrl(settings.storeDirectory, self).pipe(
      Effect.map(Option.some),
      Effect.catchTag("ServerNotRunning", () => Effect.succeed(Option.none<string>())),
      Effect.catch((failure) => reported(describeLoginFailure(failure), failure._tag))
    )
  }
)

/**
 * Reads the store directory from `config`, asks the server running there for a link, prints it, and
 * opens it when asked. Every failure, an unreadable configuration included, goes to stderr only, so
 * stdout carries the link or nothing.
 */
export const login = Effect.fn("Login.login")(function*<E extends { readonly message: string }, R>(
  config: Effect.Effect<{ readonly storeDirectory: string }, E, R>,
  open: boolean,
  self: number
) {
  const settings = yield* loginSettings(config)
  const url = yield* requestLoginUrl(settings.storeDirectory, self).pipe(
    Effect.catch((failure: LoginFailure) => reported(describeLoginFailure(failure), failure._tag))
  )
  yield* Console.log(url)
  if (open) yield* openBrowser(url)
})
