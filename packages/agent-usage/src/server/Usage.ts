/**
 * `agent-usage usage`: this Machine's usage over a range from the running server, as one JSON line
 * ({@link UsageNow}): tokens per period, agent and model, and the limit series. No cost, balance,
 * Booking or session is in it, so hostd may carry it to the herdr hub.
 *
 * Like `agent-usage limits`, the answer comes over the owner-only control socket, and failures go to
 * stderr as one sentence with a nonzero exit, so stdout carries the usage or nothing.
 *
 * @module
 */
import { Console, Effect, Runtime, Schema } from "effect"
import { UsageNow, type UsagePreset } from "../shared/contracts.js"
import {
  requestUsage,
  type ServerNotRunning,
  type SocketPathTooLong,
  type SocketPathUnsafe,
  type SocketRefused,
  type UsageNotSupported,
  type UsageReplyInvalid,
  type UsageRequestRefused,
  type UsageUnavailable
} from "./ControlSocket.js"

export type UsageFailure =
  | ServerNotRunning
  | SocketPathTooLong
  | SocketPathUnsafe
  | SocketRefused
  | UsageNotSupported
  | UsageRequestRefused
  | UsageUnavailable
  | UsageReplyInvalid

/** The failure, already explained on stderr: the runtime exits nonzero without logging it again. */
export class UsageFailed extends Schema.TaggedError<UsageFailed>()("UsageFailed", {
  reason: Schema.String
}) {
  override readonly [Runtime.errorReported] = false
}

/** One sentence per failure, naming what to do about it. */
export const describeUsageFailure = (failure: UsageFailure): string => {
  switch (failure._tag) {
    case "ServerNotRunning":
      return "agent-usage is not running on this store. Start it with `agent-usage serve` (or its service)."
    case "SocketPathUnsafe":
      return `agent-usage refused its control socket at ${failure.path}: ${failure.reason}. Remove it and restart the server.`
    case "SocketRefused":
      return `agent-usage's control socket at ${failure.path} could not be used (${failure.reason}).`
    case "SocketPathTooLong":
      return `${failure.message}, so this store has no control socket. Set AGENT_USAGE_HOME to a shorter path.`
    case "UsageNotSupported":
      return "the running agent-usage is an older version without usage. Restart it (or its service) on the installed version."
    case "UsageRequestRefused":
      switch (failure.refused) {
        case "time zone":
          return `the running agent-usage does not know the time zone ${
            JSON.stringify(failure.timeZone)
          }. Pass an IANA zone such as Europe/Amsterdam.`
        case "range":
          return `the running agent-usage does not offer the range ${
            JSON.stringify(failure.preset)
          }. Restart it (or its service) on the installed version.`
        case "malformed":
          return `the usage request was malformed (time zone ${
            JSON.stringify(failure.timeZone)
          }). Pass one IANA zone, such as Europe/Amsterdam.`
      }
    case "UsageUnavailable":
      return "the running agent-usage could not read its store; its log says why."
    case "UsageReplyInvalid":
      return "the running agent-usage answered with something that is not usage."
  }
}

const encodeUsage = Schema.encodeSync(Schema.fromJsonString(UsageNow))

const reported = (sentence: string, reason: string) =>
  Console.error(`agent-usage: ${sentence}`).pipe(Effect.andThen(Effect.fail(new UsageFailed({ reason }))))

/**
 * Reads the store directory from `config`, asks the server running there for its usage over
 * `preset` in periods local to `timeZone`, and prints it as one JSON line ({@link UsageNow}).
 */
export const usage = Effect.fn("Usage.usage")(function*<E extends { readonly message: string }, R>(
  config: Effect.Effect<{ readonly storeDirectory: string }, E, R>,
  self: number,
  preset: UsagePreset,
  timeZone: string
) {
  const settings = yield* config.pipe(
    Effect.catch((error: E) => reported(`its configuration could not be read: ${error.message}`, "ConfigError"))
  )
  const now = yield* requestUsage(settings.storeDirectory, self, preset, timeZone).pipe(
    Effect.catch((failure: UsageFailure) => reported(describeUsageFailure(failure), failure._tag))
  )
  yield* Console.log(encodeUsage(now))
})
