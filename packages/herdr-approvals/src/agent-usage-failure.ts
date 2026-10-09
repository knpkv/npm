/**
 * What a failed agent-usage command may say off this host. agent-usage explains itself on stderr,
 * and its sentences can name host paths (the control socket under the user's home, the store
 * directory, the executable); a peer's reading crosses the tailnet to the hub and reaches the
 * browser. So the raw text is logged here, on this host, and the reading carries only one of a fixed
 * set of sentences, chosen by recognising agent-usage's own wording.
 *
 * @module
 */
import { Effect, Schema } from "effect"

/** agent-usage could not answer: it exited nonzero (with its stderr), could not be started, or printed too much. */
export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  kind: Schema.Literals(["exit", "spawn", "too_large"]),
  /** Host-local text: stderr, or the spawn error. Logged, never sent. */
  detail: Schema.String
}) {}

/** agent-usage's own sentences, recognised by wording that holds no path, and what is said instead. */
const knownFailures: ReadonlyArray<readonly [RegExp, string]> = [
  [/is not running on this store/u, "agent-usage is not running on this host. Start it (or its service)."],
  [
    /older version without (?:limits|usage)/u,
    "agent-usage on this host is an older version. Restart it (or its service) on the installed version."
  ],
  [/could not read its store/u, "agent-usage on this host could not read its store; its log says why."],
  [/control socket/u, "agent-usage's control socket on this host could not be used; hostd's log says why."],
  [/does not know the time zone/u, "agent-usage on this host does not know the asked time zone."],
  [/does not offer the range/u, "agent-usage on this host does not offer the asked range."],
  [/request was malformed/u, "agent-usage on this host refused the request as malformed."],
  [/configuration could not be read/u, "agent-usage on this host could not read its configuration."],
  [/answered with something that is not/u, "agent-usage on this host answered with something unexpected."]
]

/** The fixed sentence a failure is reported by off this host. Never contains the failure's own text. */
export const failureSentence = (failure: CommandFailed): string => {
  switch (failure.kind) {
    case "spawn":
      return "The agent-usage command on this host could not be started; hostd's log says why."
    case "too_large":
      return "agent-usage on this host printed more than hostd reads."
    case "exit":
      return knownFailures.find(([pattern]) => pattern.test(failure.detail))?.[1] ??
        "agent-usage failed on this host; hostd's log has its message."
  }
}

/** Logs the failure's host-local text here and answers the sentence that may leave the host. */
export const reportFailure = (what: string, failure: CommandFailed): Effect.Effect<string> =>
  Effect.logWarning(`${what}: agent-usage failed (${failure.kind})`, failure.detail).pipe(
    Effect.as(failureSentence(failure))
  )
