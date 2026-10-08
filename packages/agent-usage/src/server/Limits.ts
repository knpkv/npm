/**
 * `agent-usage limits`: this Machine's latest limits from the running server, as one JSON line.
 *
 * The answer comes over the owner-only control socket, so the caller needs no session cookie and no
 * provider credential: hostd runs this to show limits in Connect. Failures go to stderr as one
 * sentence and end the process with a nonzero exit, so stdout carries the limits or nothing.
 *
 * @module
 */
import { Console, Effect, Runtime, Schema } from "effect"
import { LimitsNow } from "../shared/contracts.js"
import {
  type LimitsReplyInvalid,
  requestLimits,
  type ServerNotRunning,
  type SocketPathTooLong,
  type SocketPathUnsafe,
  type SocketRefused
} from "./ControlSocket.js"

export type LimitsFailure = ServerNotRunning | SocketPathTooLong | SocketPathUnsafe | SocketRefused | LimitsReplyInvalid

/** The failure, already explained on stderr: the runtime exits nonzero without logging it again. */
export class LimitsFailed extends Schema.TaggedError<LimitsFailed>()("LimitsFailed", {
  reason: Schema.String
}) {
  override readonly [Runtime.errorReported] = false
}

/** One sentence per failure, naming what to do about it. */
export const describeLimitsFailure = (failure: LimitsFailure): string => {
  switch (failure._tag) {
    case "ServerNotRunning":
      return "agent-usage is not running on this store. Start it with `agent-usage serve` (or its service)."
    case "SocketPathUnsafe":
      return `agent-usage refused its control socket at ${failure.path}: ${failure.reason}. Remove it and restart the server.`
    case "SocketRefused":
      return `agent-usage's control socket at ${failure.path} could not be used (${failure.reason}).`
    case "SocketPathTooLong":
      return `${failure.message}, so this store has no control socket. Set AGENT_USAGE_HOME to a shorter path.`
    case "LimitsReplyInvalid":
      return "the running agent-usage did not answer with limits: its store could not be read, or it is an older version (restart it)."
  }
}

const encodeLimits = Schema.encodeSync(Schema.fromJsonString(LimitsNow))

const reported = (sentence: string, reason: string) =>
  Console.error(`agent-usage: ${sentence}`).pipe(Effect.andThen(Effect.fail(new LimitsFailed({ reason }))))

/**
 * Reads the store directory from `config`, asks the server running there for its latest limits and
 * prints them as one JSON line ({@link LimitsNow}).
 */
export const limits = Effect.fn("Limits.limits")(function*<E extends { readonly message: string }, R>(
  config: Effect.Effect<{ readonly storeDirectory: string }, E, R>,
  self: number
) {
  const settings = yield* config.pipe(
    Effect.catch((error: E) => reported(`its configuration could not be read: ${error.message}`, "ConfigError"))
  )
  const now = yield* requestLimits(settings.storeDirectory, self).pipe(
    Effect.catch((failure: LimitsFailure) => reported(describeLimitsFailure(failure), failure._tag))
  )
  yield* Console.log(encodeLimits(now))
})
