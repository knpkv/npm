import { Effect, Schema, Stream } from "effect"
import type * as AiError from "effect/unstable/ai/AiError"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { makeArguments, normalizeOptions } from "./internal/configuration.js"
import { CodexTransportError, invalidRequest, transportToAiError } from "./internal/errors.js"
import { streamCodexLines } from "./internal/process.js"
import type { CodexModelOptions } from "./model.js"

/** Configuration for streaming the Codex CLI's raw JSONL events. */
export interface CodexEventStreamOptions extends CodexModelOptions {
  /** Prompt sent to the ephemeral Codex turn over stdin. */
  readonly prompt: string
}

const decodeJsonEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ type: Schema.String })))

const validateEvent = Effect.fn("CodexEvents.validateEvent")(function*(line: string) {
  yield* decodeJsonEvent(line).pipe(
    Effect.mapError((cause) =>
      new CodexTransportError({
        cause,
        diagnostic: "Codex emitted malformed JSONL",
        phase: "protocol"
      })
    )
  )
  return line
})

/**
 * Streams each non-empty `codex exec --json` record as soon as stdout emits it.
 *
 * Records are validated as Codex event JSON but otherwise returned unchanged,
 * so callers can observe native events such as command execution and agent messages.
 */
export const streamEvents = (
  options: CodexEventStreamOptions
): Stream.Stream<string, AiError.AiError, ChildProcessSpawner.ChildProcessSpawner> =>
  Stream.unwrap(Effect.gen(function*() {
    if (options.prompt.trim().length === 0) {
      return yield* invalidRequest("streamEvents", "prompt", "must not be empty")
    }

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const normalized = yield* normalizeOptions(options, "streamEvents")

    return streamCodexLines({
      args: makeArguments(normalized, undefined),
      cwd: normalized.cwd,
      executable: normalized.executable,
      maxOutputBytes: normalized.maxOutputBytes,
      maxStderrBytes: normalized.maxStderrBytes,
      prompt: options.prompt,
      spawner,
      timeout: normalized.timeout
    }).pipe(
      Stream.mapEffect(validateEvent),
      Stream.mapError((error) => transportToAiError("streamEvents", error))
    )
  }))
