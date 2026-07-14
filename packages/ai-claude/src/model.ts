import { Effect, Layer, Schema, Stream } from "effect"
import type { Duration } from "effect"
import { LanguageModel, Model } from "effect/unstable/ai"
import type { AiError, Response } from "effect/unstable/ai"
import { ChildProcessSpawner } from "effect/unstable/process"
import { invalidInput, invalidOutput, unsupportedSchema } from "./errors.js"
import { renderPrompt } from "./prompt.js"
import type { ClaudeResult } from "./protocol.js"
import { runClaude } from "./runner.js"

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_STDERR_BYTES = 256 * 1024
const DEFAULT_TIMEOUT = "2 minutes"
const STREAM_TEXT_ID = "claude-cli-output"
const JsonString = Schema.fromJsonString(Schema.Json)

/** Options for a local Claude CLI-backed Effect AI model. */
export interface ClaudeModelOptions {
  /** Working directory exposed to Claude. */
  readonly cwd: string
  /** Claude executable name or absolute path. Defaults to `claude`. */
  readonly executable?: string
  /** Claude model identifier. Defaults to the CLI-configured model. */
  readonly model?: string
  /** Workspace access granted to Claude. Defaults to `read-only`. */
  readonly access?: "read-only" | "workspace-write"
  /** Maximum duration of one CLI invocation. Defaults to two minutes. */
  readonly timeout?: Duration.Input
  /** Maximum captured stdout bytes. Defaults to 4 MiB. */
  readonly maxOutputBytes?: number
  /** Maximum captured stderr bytes. Defaults to 256 KiB. */
  readonly maxStderrBytes?: number
}

const usageFrom = (usage: ClaudeResult["usage"]): typeof Response.Usage.Encoded => ({
  inputTokens: {
    cacheRead: usage?.cache_read_input_tokens,
    cacheWrite: usage?.cache_creation_input_tokens,
    total: usage === undefined
      ? undefined
      : (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0),
    uncached: usage?.input_tokens
  },
  outputTokens: {
    reasoning: undefined,
    text: usage?.output_tokens,
    total: usage?.output_tokens
  }
})

const encodeJson = (value: unknown, method: string): Effect.Effect<string, AiError.AiError> =>
  Schema.encodeUnknownEffect(JsonString)(value).pipe(
    Effect.mapError((cause) => unsupportedSchema(cause, method))
  )

const schemaArgument = (
  options: LanguageModel.ProviderOptions,
  method: string
): Effect.Effect<string | undefined, AiError.AiError> => {
  if (options.responseFormat.type === "text") return Effect.succeed(undefined)
  const responseSchema = options.responseFormat.schema
  return Effect.try({
    try: () => Schema.toJsonSchemaDocument(responseSchema),
    catch: (cause) => unsupportedSchema(cause, method)
  }).pipe(
    Effect.flatMap((document) =>
      encodeJson({
        $defs: document.definitions,
        $schema: "https://json-schema.org/draft/2020-12/schema",
        ...document.schema
      }, method)
    )
  )
}

interface NormalizedOptions {
  readonly access: "read-only" | "workspace-write"
  readonly cwd: string
  readonly executable: string
  readonly maxOutputBytes: number
  readonly maxStderrBytes: number
  readonly model: string | undefined
  readonly timeout: Duration.Input
}

const normalizeOptionsUnsafe = (options: ClaudeModelOptions): NormalizedOptions => ({
  access: options.access ?? "read-only",
  cwd: options.cwd,
  executable: options.executable ?? "claude",
  maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  maxStderrBytes: options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
  model: options.model,
  timeout: options.timeout ?? DEFAULT_TIMEOUT
})

const normalizeOptions = (
  options: ClaudeModelOptions,
  method: string
): Effect.Effect<NormalizedOptions, AiError.AiError> => {
  const normalized = normalizeOptionsUnsafe(options)
  if (normalized.cwd.trim().length === 0) {
    return Effect.fail(invalidInput("cwd must not be empty", method))
  }
  if (!Number.isSafeInteger(normalized.maxOutputBytes) || normalized.maxOutputBytes <= 0) {
    return Effect.fail(invalidInput("maxOutputBytes must be a positive safe integer", method))
  }
  if (!Number.isSafeInteger(normalized.maxStderrBytes) || normalized.maxStderrBytes <= 0) {
    return Effect.fail(invalidInput("maxStderrBytes must be a positive safe integer", method))
  }
  return Effect.succeed(normalized)
}

const resultText = (result: ClaudeResult, method: string): Effect.Effect<string, AiError.AiError> => {
  if (result.structured_output !== undefined) return encodeJson(result.structured_output, method)
  if (result.result !== undefined) return Effect.succeed(result.result)
  return Effect.fail(invalidOutput("Claude CLI result contained no output", method))
}

const makeService = Effect.fn("ClaudeCliLanguageModel.make")(function*(options: ClaudeModelOptions) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return yield* LanguageModel.make({
    generateText: Effect.fn("ClaudeCliLanguageModel.generateText")(function*(providerOptions) {
      const prompt = yield* renderPrompt(providerOptions, "generateText")
      const jsonSchema = yield* schemaArgument(providerOptions, "generateText")
      const normalized = yield* normalizeOptions(options, "generateText")
      const result = yield* runClaude({ ...normalized, jsonSchema, prompt }, "generateText", spawner)
      const text = yield* resultText(result, "generateText")
      const parts: Array<Response.PartEncoded> = [
        { type: "text", text },
        { type: "finish", reason: "stop", response: undefined, usage: usageFrom(result.usage) }
      ]
      return parts
    }),
    streamText: (providerOptions) =>
      Stream.unwrap(Effect.gen(function*() {
        const prompt = yield* renderPrompt(providerOptions, "streamText")
        const jsonSchema = yield* schemaArgument(providerOptions, "streamText")
        const normalized = yield* normalizeOptions(options, "streamText")
        const result = yield* runClaude({ ...normalized, jsonSchema, prompt }, "streamText", spawner)
        const text = yield* resultText(result, "streamText")
        const parts: Array<Response.StreamPartEncoded> = [
          { type: "text-start", id: STREAM_TEXT_ID },
          { type: "text-delta", id: STREAM_TEXT_ID, delta: text },
          { type: "text-end", id: STREAM_TEXT_ID },
          {
            type: "finish",
            reason: "stop",
            response: undefined,
            usage: usageFrom(result.usage)
          }
        ]
        return Stream.fromIterable(parts)
      }))
  })
})

/** Creates an Effect AI model backed by a non-interactive local Claude CLI process. */
export const model = (
  options: ClaudeModelOptions
): Model.Model<"claude-cli", LanguageModel.LanguageModel, ChildProcessSpawner.ChildProcessSpawner> =>
  Model.make(
    "claude-cli",
    options.model ?? "default",
    Layer.effect(LanguageModel.LanguageModel, makeService(options))
  )
