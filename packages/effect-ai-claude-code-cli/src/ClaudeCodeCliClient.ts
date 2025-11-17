/**
 * Claude Code CLI client service.
 *
 * @since 1.0.0
 */
import * as Command from "@effect/platform/Command"
import type * as PlatformError from "@effect/platform/Error"
import type * as CommandExecutor from "@effect/platform/CommandExecutor"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as NodeContext from "@effect/platform-node/NodeContext"
import { execSync } from "node:child_process"
import {
  MessageStartEvent,
  ContentBlockStartEvent,
  ContentBlockDeltaEvent,
  ContentBlockStopEvent,
  MessageDeltaEvent,
  MessageStopEvent,
  StreamEvent,
  MessageChunk
} from "./StreamEvents.js"
import { buildCommand, rateLimitSchedule } from "./internal/utilities.js"
import { type ClaudeCodeCliError, CliNotFoundError, parseStderr } from "./ClaudeCodeCliError.js"
import { ClaudeCodeCliConfig } from "./ClaudeCodeCliConfig.js"

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
     * @returns Effect that yields a Stream of message chunks
     *
     * @example
     * ```typescript
     * import { ClaudeCodeCliClient } from "@knpkv/effect-ai-claude-code-cli"
     * import { Effect, Stream } from "effect"
     *
     * const program = Effect.gen(function* () {
     *   const client = yield* ClaudeCodeCliClient
     *   const stream = yield* client.queryStream("Write a story")
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
    ) => Effect.Effect<Stream.Stream<MessageChunk, ClaudeCodeCliError>, ClaudeCodeCliError>
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
  Schema.typeSchema(MessageStartEvent),
  Schema.typeSchema(ContentBlockStartEvent),
  Schema.typeSchema(ContentBlockDeltaEvent),
  Schema.typeSchema(ContentBlockStopEvent),
  Schema.typeSchema(MessageDeltaEvent),
  Schema.typeSchema(MessageStopEvent)
)





/**
 * Convert stream event to message chunk if applicable.
 *
 * @param event - Stream event
 * @returns Stream of message chunks (empty if not a delta event)
 * @internal
 */
const eventToChunk = (event: StreamEvent): Stream.Stream<MessageChunk> => {
  if (event instanceof ContentBlockDeltaEvent) {
    return Stream.make(new MessageChunk({ text: event.delta.text, index: event.index }))
  }
  
  // End stream on message stop
  if (event.type === "message_stop") {
    return Stream.empty
  }
  
  return Stream.empty
}

/**
 * Execute CLI command and return stream of message chunks.
 *
 * @param command - Command to execute
 * @returns Stream of message chunks with automatic retry on rate limits
 * @internal
 */
const executeCommand = (
  command: Command.Command
) =>
  Effect.gen(function*() {
    const process = yield* Command.start(command).pipe(
      Effect.mapError(
        (error: PlatformError.PlatformError) => parseStderr(String(error), 1)
      ),
      Effect.provide(NodeContext.layer)
    )

    // Create stdout stream that will be consumed by the caller
    const stdoutStream = process.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.trim().length > 0), // Skip empty lines
      Stream.filterMap((line) => {
        // Try to parse line, return None if it fails
        try {
          const json = JSON.parse(line) as any
          
          // Handle wrapped stream events: {"type":"stream_event","event":{...}}
          if (json.type === "stream_event" && json.event) {
            const parseResult = Schema.decodeUnknownSync(StreamEventSchema)(json.event)
            return Option.some(parseResult)
          }
          
          // Handle direct stream events (unlikely but possible)
          const parseResult = Schema.decodeUnknownSync(StreamEventSchema)(json)
            return Option.some(parseResult)
        } catch {
          // Skip lines that can't be parsed as stream events
          return Option.none()
        }
      }),
      Stream.flatMap(eventToChunk),
      Stream.mapError((error: ClaudeCodeCliError | PlatformError.PlatformError) =>
        typeof error === "object" && "_tag" in error && typeof error._tag === "string"
          ? error as ClaudeCodeCliError
          : parseStderr(String(error), 1)
      )
    )

    return stdoutStream
  }).pipe(Effect.retry(rateLimitSchedule))

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
        // Build command manually since Effect.Command hangs with Claude CLI
        const args = [
          "claude",
          "-p", prompt,
          "--output-format", "json",
          "--dangerously-skip-permissions"
        ]
        
        if (model) args.push("--model", model)
        if (allowedTools) allowedTools.forEach(tool => args.push("--allowedTools", tool))
        if (disallowedTools) disallowedTools.forEach(tool => args.push("--disallowedTools", tool))
        
        const result = yield* Effect.try(() => {
          const output = execSync(args.join(" "), {
            encoding: "utf8",
            timeout: 30000,
            env: { ...process.env, CLAUDE_API_KEY: undefined }
          })
          return output
        }).pipe(
          Effect.mapError((error) => parseStderr(String(error), 1))
        )
        
        // Parse JSON response to extract text
        try {
          const json = JSON.parse(result) as any
          return json.result || json.content?.[0]?.text || json.text || result
        } catch {
          return result.trim()
        }
      }).pipe(
        Effect.retry(rateLimitSchedule)
      )

    const queryStream = (
      prompt: string
    ): Effect.Effect<Stream.Stream<MessageChunk, ClaudeCodeCliError>, ClaudeCodeCliError> =>
      Effect.gen(function*() {
        const command = buildCommand(prompt, model, allowedTools, disallowedTools)
        const stream = yield* executeCommand(command)
        return stream
      }).pipe(
        Effect.scoped,
        Effect.provide(NodeContext.layer)
      )

    return ClaudeCodeCliClient.of({
      query,
      queryStream
    })
  })

/**
 * Layer that provides ClaudeCodeCliClient service.
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
}): Layer.Layer<ClaudeCodeCliClient, CliNotFoundError, ClaudeCodeCliConfig> =>
  Layer.effect(ClaudeCodeCliClient, make(options)).pipe(
    Layer.provide(NodeContext.layer)
  )

/**
 * Layer that provides ClaudeCodeCliClient using ClaudeCodeCliConfig.
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
