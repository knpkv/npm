/**
 * Claude Code CLI client service.
 *
 * @since 1.0.0
 */
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as Command from "@effect/platform/Command"
import type * as CommandExecutor from "@effect/platform/CommandExecutor"
import type * as PlatformError from "@effect/platform/Error"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { ClaudeCodeCliConfig } from "./ClaudeCodeCliConfig.js"
import { type ClaudeCodeCliError, CliNotFoundError, isClaudeCodeCliError, parseStderr } from "./ClaudeCodeCliError.js"
import { buildCommand, hasToolsConfigured, rateLimitSchedule } from "./internal/utilities.js"
import {
  ContentBlockDeltaEvent,
  ContentBlockStartChunk,
  ContentBlockStartEvent,
  ContentBlockStopChunk,
  ContentBlockStopEvent,
  type MessageChunk,
  MessageDeltaChunk,
  MessageDeltaEvent,
  MessageStartChunk,
  MessageStartEvent,
  MessageStopChunk,
  MessageStopEvent,
  type StreamEvent,
  TextChunk,
  ToolInputChunk,
  ToolUseStartChunk
} from "./StreamEvents.js"

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
 * @since 1.0.0
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
     *
     * @since 1.0.0
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
     *
     * @since 1.0.0
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
 * Schema for all stream event types.
 * @internal
 */
const StreamEventSchema = Schema.Union(
  MessageStartEvent,
  ContentBlockStartEvent,
  ContentBlockDeltaEvent,
  ContentBlockStopEvent,
  MessageDeltaEvent,
  MessageStopEvent
)

/**
 * Convert stream event to message chunk(s).
 *
 * @param event - Stream event
 * @returns Stream of message chunks
 * @internal
 */
const eventToChunk = (event: StreamEvent): Stream.Stream<MessageChunk> => {
  // Handle content block start
  if (event.type === "content_block_start") {
    const blockType = "type" in event.content_block ? String(event.content_block.type) : "unknown"

    // If it's a tool_use block, emit both content_block_start and tool_use_start
    if (blockType === "tool_use" && "id" in event.content_block && "name" in event.content_block) {
      return Stream.make(
        new ContentBlockStartChunk({ type: "content_block_start", blockType, index: event.index }),
        new ToolUseStartChunk({
          type: "tool_use_start",
          id: String(event.content_block.id),
          name: String(event.content_block.name),
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
      const process = yield* Command.start(command.pipe(Command.stdin(stdinStream))).pipe(
        Effect.mapError(
          (error: PlatformError.PlatformError) => parseStderr(String(error), 1)
        ),
        Effect.provide(NodeContext.layer)
      )

      return process.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.trim().length > 0), // Skip empty lines
        Stream.flatMap((line) => {
          try {
            const json = Schema.decodeUnknownSync(Schema.parseJson())(line)

            // Handle wrapped stream events: {"type":"stream_event","event":{...}}
            if (
              typeof json === "object" && json !== null && "type" in json && json.type === "stream_event" &&
              "event" in json
            ) {
              const parseResult = Schema.decodeUnknownSync(StreamEventSchema)(json.event)
              return Stream.make(parseResult)
            }

            // Handle direct stream events (unlikely but possible)
            const parseResult = Schema.decodeUnknownSync(StreamEventSchema)(json)
            return Stream.make(parseResult)
          } catch (error) {
            // Log parse failures for debugging
            return Stream.unwrap(
              Effect.logDebug("Failed to parse stream event line", {
                line: line.length > 100 ? line.substring(0, 100) + "..." : line,
                error
              }).pipe(
                Effect.as(Stream.empty)
              )
            )
          }
        }),
        Stream.flatMap(eventToChunk),
        Stream.mapError((error: ClaudeCodeCliError | PlatformError.PlatformError) =>
          isClaudeCodeCliError(error)
            ? error
            : parseStderr(String(error), 1)
        )
      )
    })
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

    const query = (prompt: string): Effect.Effect<string, ClaudeCodeCliError> =>
      Effect.gen(function*() {
        const useStdin = hasToolsConfigured(allowedTools, disallowedTools)
        const command = buildCommand(prompt, model, allowedTools, disallowedTools, false).pipe(
          Command.stdin(useStdin ? Stream.make(prompt).pipe(Stream.encodeText) : Stream.empty)
        )
        const output = yield* Command.string(command).pipe(
          Effect.mapError((error: PlatformError.PlatformError) => parseStderr(String(error), 1))
        )

        // Parse JSON response to extract text
        try {
          const json = Schema.decodeUnknownSync(Schema.parseJson())(output)
          if (typeof json === "object" && json !== null) {
            if ("result" in json && typeof json.result === "string") return json.result
            if (
              "content" in json && Array.isArray(json.content) && json.content[0] &&
              typeof json.content[0] === "object" && "text" in json.content[0]
            ) {
              return String(json.content[0].text)
            }
            if ("text" in json && typeof json.text === "string") return json.text
          }
          return output.trim()
        } catch {
          return output.trim()
        }
      }).pipe(
        Effect.retry(rateLimitSchedule),
        Effect.provide(NodeContext.layer)
      )

    const queryStream = (
      prompt: string
    ): Stream.Stream<MessageChunk, ClaudeCodeCliError> => {
      const command = buildCommand(prompt, model, allowedTools, disallowedTools)
      const useStdin = hasToolsConfigured(allowedTools, disallowedTools)
      return executeCommand(command, useStdin ? prompt : undefined)
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
 * @since 1.0.0
 */
export const layer = (options?: {
  model?: string
  allowedTools?: ReadonlyArray<string>
  disallowedTools?: ReadonlyArray<string>
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
 * @since 1.0.0
 */
export const layerConfig: Layer.Layer<ClaudeCodeCliClient, CliNotFoundError, ClaudeCodeCliConfig> = Layer.effect(
  ClaudeCodeCliClient,
  Effect.gen(function*() {
    const config = yield* ClaudeCodeCliConfig
    return yield* make(config)
  })
).pipe(Layer.provide(NodeContext.layer))
