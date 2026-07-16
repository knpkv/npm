import { Config, Effect, Layer, Option, Schema, Stream } from "effect"
import type { Duration } from "effect"
import { LanguageModel, Model } from "effect/unstable/ai"
import type { AiError, Response } from "effect/unstable/ai"
import { ChildProcessSpawner } from "effect/unstable/process"
import { configurationFailure, invalidInput, invalidOutput, unsupportedSchema } from "./errors.js"
import { renderPrompt } from "./prompt.js"
import type { ClaudeResult } from "./protocol.js"
import { runClaude } from "./runner.js"

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_STDERR_BYTES = 256 * 1024
const DEFAULT_TIMEOUT = "2 minutes"
const STREAM_TEXT_ID = "claude-cli-output"
const JsonString = Schema.fromJsonString(Schema.Json)

const optionalEnvironmentValue = (name: string) => Config.option(Config.string(name))

const childEnvironment = Config.all({
  anthropicApiKey: optionalEnvironmentValue("ANTHROPIC_API_KEY"),
  anthropicAuthToken: optionalEnvironmentValue("ANTHROPIC_AUTH_TOKEN"),
  anthropicBaseUrl: optionalEnvironmentValue("ANTHROPIC_BASE_URL"),
  claudeConfigDirectory: optionalEnvironmentValue("CLAUDE_CONFIG_DIR"),
  home: optionalEnvironmentValue("HOME"),
  path: optionalEnvironmentValue("PATH"),
  userProfile: optionalEnvironmentValue("USERPROFILE"),
  xdgConfigHome: optionalEnvironmentValue("XDG_CONFIG_HOME")
}).pipe(
  Config.map((configured) => ({
    ...(Option.isSome(configured.anthropicApiKey) ? { ANTHROPIC_API_KEY: configured.anthropicApiKey.value } : {}),
    ...(Option.isSome(configured.anthropicAuthToken)
      ? { ANTHROPIC_AUTH_TOKEN: configured.anthropicAuthToken.value }
      : {}),
    ...(Option.isSome(configured.anthropicBaseUrl) ? { ANTHROPIC_BASE_URL: configured.anthropicBaseUrl.value } : {}),
    ...(Option.isSome(configured.claudeConfigDirectory)
      ? { CLAUDE_CONFIG_DIR: configured.claudeConfigDirectory.value }
      : {}),
    ...(Option.isSome(configured.home) ? { HOME: configured.home.value } : {}),
    ...(Option.isSome(configured.path) ? { PATH: configured.path.value } : {}),
    ...(Option.isSome(configured.userProfile) ? { USERPROFILE: configured.userProfile.value } : {}),
    ...(Option.isSome(configured.xdgConfigHome) ? { XDG_CONFIG_HOME: configured.xdgConfigHome.value } : {})
  }))
)

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
  readonly environment: Readonly<Record<string, string>>
  readonly executable: string
  readonly maxOutputBytes: number
  readonly maxStderrBytes: number
  readonly model: string | undefined
  readonly timeout: Duration.Input
}

const normalizeOptions = Effect.fn("ClaudeCliLanguageModel.normalizeOptions")(function*(
  options: ClaudeModelOptions,
  method: string
): Effect.fn.Return<NormalizedOptions, AiError.AiError> {
  const normalized: NormalizedOptions = {
    access: options.access ?? "read-only",
    cwd: options.cwd,
    environment: yield* childEnvironment.pipe(
      Effect.mapError((cause) => configurationFailure(cause, method))
    ),
    executable: options.executable ?? "claude",
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    maxStderrBytes: options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
    model: options.model,
    timeout: options.timeout ?? DEFAULT_TIMEOUT
  }
  if (normalized.cwd.trim().length === 0) {
    return yield* invalidInput("cwd must not be empty", method)
  }
  if (!Number.isSafeInteger(normalized.maxOutputBytes) || normalized.maxOutputBytes <= 0) {
    return yield* invalidInput("maxOutputBytes must be a positive safe integer", method)
  }
  if (!Number.isSafeInteger(normalized.maxStderrBytes) || normalized.maxStderrBytes <= 0) {
    return yield* invalidInput("maxStderrBytes must be a positive safe integer", method)
  }
  return normalized
})

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
