/**
 * What a failed agent-usage command may say off this host. agent-usage explains itself on stderr,
 * and its sentences can name host paths (the control socket under the user's home, the store
 * directory, the executable); a peer's reading crosses the tailnet to the hub and reaches the
 * browser. So the raw text is logged here, on this host, and the reading carries only one of a fixed
 * set of sentences, chosen by recognising agent-usage's own wording.
 *
 * @module
 */
import { failureSentences } from "@knpkv/herdr-connect"
import { Effect, Schema } from "effect"

/** agent-usage could not answer: it exited nonzero (with its stderr), could not be started, or printed too much. */
export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  kind: Schema.Literals(["exit", "spawn", "too_large"]),
  /** Host-local text: stderr, or the spawn error. Logged, never sent. */
  detail: Schema.String
}) {}

/** agent-usage's own sentences, recognised by wording that holds no path, and what is said instead. */
const knownFailures: ReadonlyArray<readonly [RegExp, string]> = [
  [/is not running on this store/u, failureSentences.notRunning],
  [/older version without (?:limits|usage)/u, failureSentences.olderVersion],
  [/could not read its store/u, failureSentences.storeUnreadable],
  [/control socket/u, failureSentences.controlSocket],
  [/does not know the time zone/u, failureSentences.unknownTimeZone],
  [/does not offer the range/u, failureSentences.unknownRange],
  [/request was malformed/u, failureSentences.malformed],
  [/configuration could not be read/u, failureSentences.configuration],
  [/answered with something that is not/u, failureSentences.unexpectedAnswer]
]

/** The fixed sentence a failure is reported by off this host. Never contains the failure's own text. */
export const failureSentence = (failure: CommandFailed): string => {
  switch (failure.kind) {
    case "spawn":
      return failureSentences.spawn
    case "too_large":
      return failureSentences.tooLarge
    case "exit":
      return knownFailures.find(([pattern]) => pattern.test(failure.detail))?.[1] ?? failureSentences.other
  }
}

/** Logs the failure's host-local text here and answers the sentence that may leave the host. */
export const reportFailure = (what: string, failure: CommandFailed): Effect.Effect<string> =>
  Effect.logWarning(`${what}: agent-usage failed (${failure.kind})`, failure.detail).pipe(
    Effect.as(failureSentence(failure))
  )
