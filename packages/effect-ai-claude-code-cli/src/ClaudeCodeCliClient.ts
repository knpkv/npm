/**
 * Claude Code CLI client service.
 */
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as Command from "@effect/platform/Command"
import type * as CommandExecutor from "@effect/platform/CommandExecutor"
import type * as PlatformError from "@effect/platform/Error"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { ClaudeCodeCliConfig } from "./ClaudeCodeCliConfig.js"
import {
  type ClaudeCodeCliError,
  CliNotFoundError,
  isClaudeCodeCliError,
  parseStderr,
  ValidationError
} from "./ClaudeCodeCliError.js"
import { buildCommand, extractErrorMessage, hasToolsConfigured, rateLimitSchedule } from "./internal/utilities.js"
import { extractText, JsonResponse } from "./ResponseSchemas.js"
import {
  ContentBlockStartChunk,
  ContentBlockStopChunk,
  type MessageChunk,
  MessageDeltaChunk,
  MessageStartChunk,
  MessageStopChunk,
  StreamEvent,
  type StreamEvent as StreamEventType,
  TextChunk,
  ToolInputChunk,
  ToolUseStartChunk,
  WrappedStreamEvent
} from "./StreamEvents.js"
import * as Validation from "./Validation.js"

/**
 * Claude Code CLI client for executing queries programmatically.
 *
 * Provides methods for basic queries, streaming, and tool calling via
 * the Claude Code CLI with proper Effect-TS patterns.
 *
 * @example
 * ```typescript
 * import { ClaudeCodeCliClient } from "@knpkv/effect-ai-claude-code-cli"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* ClaudeCodeCliClient
 *   const response = yield* client.query("What is Effect?")
 *   console.log(response)
 * })
 *
 * Effect.runPromise(
 *   program.pipe(Effect.provide(ClaudeCodeCliClient.layer()))
 * )
 * ```
 *
 * @category Client
 */
export class ClaudeCodeCliClient extends Context.Tag("@knpkv/effect-ai-claude-code-cli/ClaudeCodeCliClient")<
  ClaudeCodeCliClient,
  {
    /**
     * Execute a query and return the complete response.
     *
     * @param prompt - The text prompt to send to Claude
     * @returns Effect that yields the complete response text
     *
     * @example
     * ```typescript
     * import { ClaudeCodeCliClient } from "@knpkv/effect-ai-claude-code-cli"
     * import { Effect } from "effect"
     *
     * const program = Effect.gen(function* () {
     *   const client = yield* ClaudeCodeCliClient
     *   const response = yield* client.query("Explain monads")
     *   console.log(response)
     * })
     * ```
     */
    readonly query: (prompt: string) => Effect.Effect<string, ClaudeCodeCliError>

    /**
     * Execute a query and return a stream of response chunks.
     *
     * Enables real-time processing of the response as it's generated.
     *
     * @param prompt - The text prompt to send to Claude
     * @returns Stream of message chunks
     *
     * @example
     * ```typescript
     * import { ClaudeCodeCliClient } from "@knpkv/effect-ai-claude-code-cli"
     * import { Effect, Stream } from "effect"
     *
     * const program = Effect.gen(function* () {
     *   const client = yield* ClaudeCodeCliClient
     *   const stream = client.queryStream("Write a story")
     *   yield* stream.pipe(
     *     Stream.runForEach(chunk =>
     *       Effect.sync(() => process.stdout.write(chunk.text))
     *     )
     *   )
     * })
     * ```
     */
    readonly queryStream: (
      prompt: string
    ) => Stream.Stream<MessageChunk, ClaudeCodeCliError>
  }
>() {}

/**
 * Check if Claude CLI is available in PATH.
 *
 * @returns Effect that succeeds if CLI is found, fails with CliNotFoundError otherwise
 * @internal
 */
const checkCliAvailable = () =>
  Effect.gen(function*() {
    const code = yield* Command.make("claude", "--version").pipe(
      Command.exitCode,
      Effect.mapError(() => new CliNotFoundError())
    )

    if (code !== 0) {
      return yield* Effect.fail(new CliNotFoundError())
    }
  })

/**
 * Convert stream event to message chunk(s).
 *
 * @param event - Stream event
 * @returns Stream of message chunks
 * @internal
 */
const eventToChunk = (event: StreamEventType): Stream.Stream<MessageChunk> => {
  // Handle content block start
  if (event.type === "content_block_start") {
    const blockType = event.content_block.type

    // If it's a tool_use block, emit both content_block_start and tool_use_start
    if (event.content_block.type === "tool_use") {
      return Stream.make(
        new ContentBlockStartChunk({ type: "content_block_start", blockType, index: event.index }),
        new ToolUseStartChunk({
          type: "tool_use_start",
          id: event.content_block.id,
          name: event.content_block.name,
          index: event.index
        })
      )
    }

    return Stream.make(
      new ContentBlockStartChunk({ type: "content_block_start", blockType, index: event.index })
    )
  }

  // Handle content block delta
  if (event.type === "content_block_delta") {
    if (event.delta.type === "text_delta") {
      return Stream.make(new TextChunk({ type: "text", text: event.delta.text, index: event.index }))
    }

    if (event.delta.type === "input_json_delta") {
      return Stream.make(
        new ToolInputChunk({ type: "tool_input", partialJson: event.delta.partial_json, index: event.index })
      )
    }
  }

  // Handle content block stop
  if (event.type === "content_block_stop") {
    return Stream.make(new ContentBlockStopChunk({ type: "content_block_stop", index: event.index }))
  }

  // Handle message start
  if (event.type === "message_start") {
    return Stream.make(new MessageStartChunk({ type: "message_start", message: event.message }))
  }

  // Handle message delta (contains usage, stop_reason, etc)
  if (event.type === "message_delta") {
    return Stream.make(
      new MessageDeltaChunk({
        type: "message_delta",
        delta: event.delta,
        usage: event.usage
      })
    )
  }

  // Handle message stop (end of stream)
  if (event.type === "message_stop") {
    return Stream.make(new MessageStopChunk({ type: "message_stop" }))
  }

  return Stream.empty
}

/**
 * Execute CLI command and return stream of message chunks.
 *
 * Uses Stream.unwrapScoped for proper resource management - the CLI process
 * is automatically cleaned up when the stream completes or is interrupted.
 *
 * @param command - Command to execute
 * @param promptText - Optional prompt text to pass via stdin
 * @returns Stream of message chunks with automatic retry on rate limits
 * @internal
 */
const executeCommand = (
  command: Command.Command,
  promptText?: string
): Stream.Stream<MessageChunk, ClaudeCodeCliError> => {
  const stdinStream = promptText ? Stream.make(promptText).pipe(Stream.encodeText) : Stream.empty

  return Stream.unwrapScoped(
    Effect.gen(function*() {
      // Command.start returns a scoped resource that automatically kills
      // the process when the scope is closed
      const process = yield* Command.start(command.pipe(Command.stdin(stdinStream))).pipe(
        Effect.mapError(
          (error: PlatformError.PlatformError) => parseStderr(extractErrorMessage(error), 1)
        ),
        Effect.provide(NodeContext.layer)
      )

      return process.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.trim().length > 0), // Skip empty lines
        Stream.flatMap((line) =>
          Stream.unwrap(
            Effect.gen(function*() {
              const json = yield* Schema.decodeUnknown(Schema.parseJson())(line)

              // Try wrapped format first: {"type":"stream_event","event":{...}}
              // Falls back to direct stream event format if wrapped decode fails
              const event = yield* Schema.decodeUnknown(WrappedStreamEvent)(json).pipe(
                Effect.map((wrapped) => wrapped.event),
                Effect.orElse(() => Schema.decodeUnknown(StreamEvent)(json))
              )

              return Stream.make(event)
            }).pipe(
              Effect.catchAll((error) =>
                Effect.logWarning("Failed to parse stream event line", {
                  line: line.length > 100 ? line.substring(0, 100) + "..." : line,
                  error
                }).pipe(Effect.as(Stream.empty))
              )
            )
          )
        ),
        Stream.flatMap(eventToChunk),
        Stream.mapError((error: ClaudeCodeCliError | PlatformError.PlatformError) =>
          isClaudeCodeCliError(error)
            ? error
            : parseStderr(extractErrorMessage(error), 1)
        )
      )
    }).pipe(
      Effect.mapError((error): ClaudeCodeCliError =>
        isClaudeCodeCliError(error) ? error : parseStderr(extractErrorMessage(error), 1)
      )
    )
  )
}

/**
 * Create Claude Code CLI client instance.
 *
 * @param options - Optional configuration overrides
 * @returns Client service instance
 * @internal
 */
const make = (options?: {
  model?: string
  allowedTools?: ReadonlyArray<string>
  disallowedTools?: ReadonlyArray<string>
  dangerouslySkipPermissions?: boolean
}): Effect.Effect<
  Context.Tag.Service<typeof ClaudeCodeCliClient>,
  CliNotFoundError,
  ClaudeCodeCliConfig | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function*() {
    yield* checkCliAvailable()

    const config = yield* ClaudeCodeCliConfig.pipe(
      Effect.orElseSucceed(() => ClaudeCodeCliConfig.of({}))
    )

    const model = options?.model ?? config.model
    const allowedTools = options?.allowedTools ?? config.allowedTools
    const disallowedTools = options?.disallowedTools ?? config.disallowedTools
    const dangerouslySkipPermissions = options?.dangerouslySkipPermissions ?? config.dangerouslySkipPermissions ?? false

    const query = (prompt: string): Effect.Effect<string, ClaudeCodeCliError> =>
      Effect.gen(function*() {
        // Validate prompt for security (prevent command injection)
        yield* Validation.validatePrompt(prompt).pipe(
          Effect.mapError((error) => new ValidationError({ message: error.message }))
        )
        const useStdin = hasToolsConfigured(allowedTools, disallowedTools)
        const command = buildCommand(prompt, model, allowedTools, disallowedTools, dangerouslySkipPermissions, false)
          .pipe(
            Command.stdin(useStdin ? Stream.make(prompt).pipe(Stream.encodeText) : Stream.empty)
          )
        const output = yield* Command.string(command).pipe(
          Effect.mapError((error: PlatformError.PlatformError) => parseStderr(extractErrorMessage(error), 1))
        )

        // Parse JSON response to extract text
        const jsonOption = yield* Schema.decodeUnknown(Schema.parseJson())(output).pipe(
          Effect.andThen((json) => Schema.decodeUnknown(JsonResponse)(json)),
          Effect.match({
            onFailure: () => Option.none(),
            onSuccess: Option.some
          })
        )

        return Option.match(jsonOption, {
          onNone: () => output.trim(),
          onSome: extractText
        })
      }).pipe(
        Effect.retry(rateLimitSchedule),
        Effect.provide(NodeContext.layer)
      )

    const queryStream = (
      prompt: string
    ): Stream.Stream<MessageChunk, ClaudeCodeCliError> => {
      // Validate prompt for security (prevent command injection)
      const validated = Validation.validatePrompt(prompt).pipe(
        Effect.mapError((error) => new ValidationError({ message: error.message }))
      )
      return Stream.unwrap(
        Effect.map(validated, () => {
          const command = buildCommand(prompt, model, allowedTools, disallowedTools, dangerouslySkipPermissions)
          const useStdin = hasToolsConfigured(allowedTools, disallowedTools)
          return executeCommand(command, useStdin ? prompt : undefined)
        })
      )
    }

    return ClaudeCodeCliClient.of({
      query,
      queryStream
    })
  })

/**
 * Layer that provides ClaudeCodeCliClient service with direct configuration.
 *
 * Use this layer when you want to provide configuration inline without using
 * ClaudeCodeCliConfig service. This is the simpler approach for most use cases.
 *
 * For configuration via ClaudeCodeCliConfig service, use {@link layerConfig} instead.
 *
 * @param options - Optional configuration overrides
 * @returns Layer providing the client service
 *
 * @example
 * ```typescript
 * import { ClaudeCodeCliClient } from "@knpkv/effect-ai-claude-code-cli"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* ClaudeCodeCliClient
 *   return yield* client.query("Hello")
 * })
 *
 * Effect.runPromise(
 *   program.pipe(
 *     Effect.provide(ClaudeCodeCliClient.layer({ model: "claude-sonnet-4-5" }))
 *   )
 * )
 * ```
 *
 * @category Layers
 */
export const layer = (options?: {
  model?: string
  allowedTools?: ReadonlyArray<string>
  disallowedTools?: ReadonlyArray<string>
  dangerouslySkipPermissions?: boolean
}): Layer.Layer<ClaudeCodeCliClient, CliNotFoundError> =>
  Layer.effect(ClaudeCodeCliClient, make(options)).pipe(
    Layer.provide(ClaudeCodeCliConfig.default),
    Layer.provide(NodeContext.layer)
  )

/**
 * Layer that provides ClaudeCodeCliClient using ClaudeCodeCliConfig service.
 *
 * Use this layer when you want to share configuration across multiple services
 * via ClaudeCodeCliConfig. This is useful when building larger applications where
 * configuration needs to be centralized.
 *
 * For simpler use cases with inline configuration, use {@link layer} instead.
 *
 * @example
 * ```typescript
 * import { ClaudeCodeCliClient, ClaudeCodeCliConfig } from "@knpkv/effect-ai-claude-code-cli"
 * import { Effect, Layer } from "effect"
 *
 * const config = Layer.succeed(
 *   ClaudeCodeCliConfig,
 *   ClaudeCodeCliConfig.of({ model: "claude-sonnet-4-5" })
 * )
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* ClaudeCodeCliClient
 *   return yield* client.query("Hello")
 * })
 *
 * Effect.runPromise(
 *   program.pipe(
 *     Effect.provide(ClaudeCodeCliClient.layerConfig),
 *     Effect.provide(config)
 *   )
 * )
 * ```
 *
 * @category Layers
 */
export const layerConfig: Layer.Layer<ClaudeCodeCliClient, CliNotFoundError, ClaudeCodeCliConfig> = Layer.effect(
  ClaudeCodeCliClient,
  Effect.gen(function*() {
    const config = yield* ClaudeCodeCliConfig
    return yield* make(config)
  })
).pipe(Layer.provide(NodeContext.layer))
