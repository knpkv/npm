import { Effect, Schema, Stream } from "effect"
import * as FileSystem from "effect/FileSystem"
import type * as AiError from "effect/unstable/ai/AiError"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { makeArguments, normalizeOptions, validatePrompt } from "./internal/configuration.js"
import { CodexTransportError, invalidRequest, transportToAiError } from "./internal/errors.js"
import { makeStreamOutputSchemaFile } from "./internal/outputSchema.js"
import { resolvePromptOnlyDisabledFeatures, streamCodexLines } from "./internal/process.js"
import type { CodexModelOptions } from "./model.js"

/** Configuration for streaming the Codex CLI's raw JSONL events. */
export interface CodexEventStreamOptions extends CodexModelOptions {
  /** Prompt sent to the ephemeral Codex turn over stdin. */
  readonly prompt: string
  /** Native JSON Schema constraint passed to `codex exec --output-schema`. */
  readonly outputSchema?: Schema.Top
}

type OrdinaryEventStreamOptions = Omit<CodexEventStreamOptions, "outputSchema" | "promptOnly"> & {
  readonly promptOnly?: false
}

type StructuredEventStreamOptions = Omit<CodexEventStreamOptions, "outputSchema" | "promptOnly"> & {
  readonly outputSchema: Schema.Top
  readonly promptOnly?: false
}

type PromptOnlyEventStreamOptions = Omit<CodexEventStreamOptions, "promptOnly"> & {
  readonly promptOnly: true
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
 * A native output schema or literal `promptOnly: true` additionally requires
 * `FileSystem`; an ordinary unconstrained stream remains spawner-only.
 */
export function streamEvents(
  options: PromptOnlyEventStreamOptions
): Stream.Stream<
  string,
  AiError.AiError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
>
export function streamEvents(
  options: OrdinaryEventStreamOptions
): Stream.Stream<string, AiError.AiError, ChildProcessSpawner.ChildProcessSpawner>
export function streamEvents(
  options: StructuredEventStreamOptions
): Stream.Stream<
  string,
  AiError.AiError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
>
export function streamEvents(
  options: CodexEventStreamOptions
): Stream.Stream<
  string,
  AiError.AiError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
>
export function streamEvents(
  options: CodexEventStreamOptions
): Stream.Stream<
  string,
  AiError.AiError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> {
  return Stream.unwrap(Effect.gen(function*() {
    if (options.prompt.trim().length === 0) {
      return yield* invalidRequest("streamEvents", "prompt", "must not be empty")
    }

    const normalized = yield* normalizeOptions(options, "streamEvents")
    yield* validatePrompt(options.prompt, normalized.maxPromptBytes, "streamEvents")
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const fileSystem = normalized.promptOnly || options.outputSchema !== undefined
      ? yield* FileSystem.FileSystem
      : undefined
    const promptOnlyDisabledFeatures = normalized.promptOnly
      ? yield* Effect.gen(function*() {
        if (fileSystem === undefined) return []
        return yield* resolvePromptOnlyDisabledFeatures(normalized, spawner, fileSystem, "streamEvents")
      })
      : []
    const schemaFile = options.outputSchema === undefined || fileSystem === undefined
      ? undefined
      : yield* makeStreamOutputSchemaFile(fileSystem, options.outputSchema).pipe(
        Effect.mapError((error) => transportToAiError("streamEvents", error))
      )
    const cleanupSchema = schemaFile === undefined || fileSystem === undefined
      ? Effect.void
      : fileSystem.remove(schemaFile).pipe(Effect.ignore)

    return streamCodexLines({
      args: makeArguments(normalized, schemaFile, promptOnlyDisabledFeatures),
      cwd: normalized.cwd,
      environment: normalized.environment,
      executable: normalized.executable,
      maxOutputBytes: normalized.maxOutputBytes,
      maxStderrBytes: normalized.maxStderrBytes,
      prompt: options.prompt,
      spawner,
      timeout: normalized.timeout
    }).pipe(
      Stream.mapEffect(validateEvent),
      Stream.mapError((error) => transportToAiError("streamEvents", error)),
      Stream.ensuring(cleanupSchema)
    )
  }))
}
