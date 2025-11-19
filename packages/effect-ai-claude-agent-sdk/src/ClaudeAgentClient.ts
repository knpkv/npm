/**
 * Claude Agent SDK client service.
 *
 * @category Client
 */

import type { Options as SdkOptions, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk"
import type { Scope } from "effect"
import { Console, Context, Effect, Layer, Stream } from "effect"
import type * as Brand from "./Brand.js"
import * as AgentConfig from "./ClaudeAgentConfig.js"
import * as AgentError from "./ClaudeAgentError.js"
import * as Tool from "./ClaudeAgentTool.js"
import * as Conversion from "./internal/conversion.js"
import * as Streaming from "./internal/streaming.js"
import * as Validation from "./internal/validation.js"
import type * as MessageSchemas from "./MessageSchemas.js"

/**
 * Options for executing a query.
 *
 * @category Client
 */
export interface QueryOptions {
  /**
   * The prompt to send to the agent.
   */
  readonly prompt: string

  /**
   * API key source for authentication.
   */
  readonly apiKeySource?: Brand.ApiKeySource

  /**
   * Working directory for SDK execution.
   */
  readonly workingDirectory?: string

  /**
   * List of allowed tools.
   */
  readonly allowedTools?: ReadonlyArray<Tool.ToolNameOrString>

  /**
   * List of disallowed tools.
   */
  readonly disallowedTools?: ReadonlyArray<Tool.ToolNameOrString>

  /**
   * Custom permission callback.
   */
  readonly canUseTool?: Tool.CanUseToolCallback

  /**
   * Dangerously skip all permission checks.
   * WARNING: Only use for trusted, non-interactive automation.
   * Default: false (permissions required)
   */
  readonly dangerouslySkipPermissions?: boolean
}

/**
 * Claude Agent Client service interface.
 *
 * Provides methods for executing queries against the Claude Agent SDK
 * with full Effect integration.
 *
 * @category Client
 */
export interface ClaudeAgentClient {
  /**
   * Execute a query and return a stream of message events.
   *
   * @example
   * ```typescript
   * import { Effect, Stream } from "effect"
   * import * as AgentClient from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentClient"
   *
   * const program = Effect.gen(function* () {
   *   const client = yield* AgentClient.ClaudeAgentClient
   *
   *   const stream = client.query({
   *     prompt: "What is Effect?"
   *   })
   *
   *   yield* Stream.runForEach(stream, (message) =>
   *     Effect.sync(() => console.log(message))
   *   )
   * })
   *
   * Effect.runPromise(
   *   program.pipe(Effect.provide(AgentClient.layer()))
   * )
   * ```
   */
  readonly query: (options: QueryOptions) => Stream.Stream<MessageSchemas.MessageEvent, AgentError.AgentError, never>

  /**
   * Execute a query and collect all assistant messages into a single string.
   *
   * **Performance Note**: This method collects the entire message stream into memory
   * before returning the concatenated text. For very large responses, consider using
   * `query()` to process the stream incrementally.
   *
   * @example
   * ```typescript
   * import { Effect } from "effect"
   * import * as AgentClient from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentClient"
   *
   * const program = Effect.gen(function* () {
   *   const client = yield* AgentClient.ClaudeAgentClient
   *
   *   const result = yield* client.queryText({
   *     prompt: "Explain TypeScript in one sentence",
   *     allowedTools: []
   *   })
   *
   *   console.log(result)
   * })
   *
   * Effect.runPromise(
   *   program.pipe(Effect.provide(AgentClient.layer()))
   * )
   * ```
   */
  readonly queryText: (options: QueryOptions) => Effect.Effect<string, AgentError.AgentError, never>

  /**
   * Execute a query and return a stream of raw SDK messages without conversion.
   *
   * Returns unconverted SDK message objects for low-level access to chunk details.
   *
   * @example
   * ```typescript
   * import { Effect, Stream } from "effect"
   * import * as AgentClient from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentClient"
   *
   * const program = Effect.gen(function* () {
   *   const client = yield* AgentClient.ClaudeAgentClient
   *
   *   const stream = client.queryRaw({
   *     prompt: "What is Effect?"
   *   })
   *
   *   yield* Stream.runForEach(stream, (sdkMessage) =>
   *     Effect.sync(() => console.log(sdkMessage))
   *   )
   * })
   *
   * Effect.runPromise(
   *   program.pipe(Effect.provide(AgentClient.layer()))
   * )
   * ```
   */
  readonly queryRaw: (options: QueryOptions) => Stream.Stream<SDKMessage, AgentError.AgentError, never>
}

/**
 * Claude Agent Client service tag.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import * as AgentClient from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentClient"
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* AgentClient.ClaudeAgentClient
 *   return client
 * })
 * ```
 *
 * @category Client
 */
export const ClaudeAgentClient = Context.GenericTag<ClaudeAgentClient>(
  "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentClient"
)

/**
 * Create a Claude Agent Client service.
 *
 * @internal
 */
const makeClient = (config: AgentConfig.ClaudeAgentConfig): Effect.Effect<ClaudeAgentClient, never, never> =>
  Effect.gen(function*() {
    /**
     * Shared query preparation logic.
     * Handles validation, config merging, and SDK option building.
     *
     * @param options - Query options
     * @returns Effect that resolves to validated SDK options and prompt
     */
    const prepareQuery = (options: QueryOptions): Effect.Effect<
      {
        readonly prompt: string
        readonly sdkOptions: SdkOptions
      },
      AgentError.ValidationError,
      never
    > =>
      Effect.gen(function*() {
        // Validate inputs
        yield* Validation.validatePrompt(options.prompt)
        yield* Validation.validateToolLists(options)
        yield* Validation.validateWorkingDirectory(options.workingDirectory)

        // Merge config with query options (query options take precedence)
        const apiKeySource = options.apiKeySource ?? config.apiKeySource
        const workingDirectory = options.workingDirectory ?? config.workingDirectory
        let allowedTools = options.allowedTools ?? config.allowedTools
        let disallowedTools = options.disallowedTools ?? config.disallowedTools
        const canUseTool = options.canUseTool ?? config.canUseTool
        const dangerouslySkipPermissions = options.dangerouslySkipPermissions ?? config.dangerouslySkipPermissions ??
          false

        // Warn if dangerouslySkipPermissions is enabled
        if (dangerouslySkipPermissions) {
          yield* Console.error(
            "⚠️  SECURITY WARNING: dangerouslySkipPermissions is enabled! " +
              "All tool permissions are bypassed. " +
              "Only use this for trusted, non-interactive automation."
          )
        }

        // Fail fast if hooks are configured but not yet implemented
        if (config.hooks && Object.keys(config.hooks).length > 0) {
          return yield* Effect.fail(
            new AgentError.ValidationError({
              field: "hooks",
              message: "Lifecycle hooks are not yet implemented. " +
                "Remove hooks from config or wait for future release. " +
                "See README 'Known Limitations' section for details.",
              input: Object.keys(config.hooks)
            })
          )
        }

        // Handle empty allowedTools array as "deny all"
        // Convert to disallowedTools: allTools (same as CLI behavior)
        // IMPORTANT: Tool.allTools must be kept in sync with SDK tools.
        // When the SDK adds new tools, update ClaudeAgentTool.allTools to include them.
        if (allowedTools !== undefined && allowedTools.length === 0) {
          allowedTools = undefined
          disallowedTools = [...Tool.allTools, ...(disallowedTools || [])]
        }

        // Build SDK query options
        const sdkOptions: SdkOptions = {
          ...(apiKeySource && { apiKeySource }),
          ...(workingDirectory && { cwd: workingDirectory }),
          ...(allowedTools && { allowedTools: [...allowedTools] }),
          ...(disallowedTools && { disallowedTools: [...disallowedTools] }),
          ...(dangerouslySkipPermissions && { allowDangerouslySkipPermissions: dangerouslySkipPermissions }),
          ...(canUseTool && {
            // Convert Effect-based canUseTool to Promise-based for SDK
            canUseTool: async (toolName: string, input: Record<string, unknown>) => {
              try {
                // Add catchAll for safety - ensures Effect failures are handled gracefully
                const result = await Effect.runPromise(
                  canUseTool(toolName).pipe(
                    Effect.catchAll(() => Effect.succeed(false))
                  )
                )
                return result
                  ? { behavior: "allow" as const, updatedInput: input }
                  : { behavior: "deny" as const, message: `Tool '${toolName}' is not allowed` }
              } catch (error) {
                return {
                  behavior: "deny" as const,
                  message: `Tool permission check failed: ${String(error)}`
                }
              }
            }
          })
        }

        return { prompt: options.prompt, sdkOptions }
      })

    const queryImpl = (options: QueryOptions) =>
      Stream.unwrap(
        Effect.gen(function*() {
          const { prompt, sdkOptions } = yield* prepareQuery(options)
          const generator = sdkQuery({ prompt, options: sdkOptions })
          const rawStream = Streaming.asyncIterableToStream(
            generator,
            (error) =>
              new AgentError.SdkError({
                message: `SDK query failed: ${String(error)}`,
                cause: error
              })
          )
          return rawStream.pipe(Stream.mapEffect((sdkMessage) => Conversion.convertSdkMessage(sdkMessage)))
        })
      )

    const queryRawImpl = (options: QueryOptions) =>
      Stream.unwrap(
        Effect.gen(function*() {
          const { prompt, sdkOptions } = yield* prepareQuery(options)
          const generator = sdkQuery({ prompt, options: sdkOptions })
          return Streaming.asyncIterableToStream(
            generator,
            (error) =>
              new AgentError.SdkError({
                message: `SDK query failed: ${String(error)}`,
                cause: error
              })
          )
        })
      )

    const queryTextImpl = (options: QueryOptions) =>
      Effect.gen(function*() {
        const stream = queryImpl(options)
        const messages = yield* Streaming.collectStream(stream)
        return Conversion.collectAssistantText(messages)
      })

    return {
      query: queryImpl,
      queryRaw: queryRawImpl,
      queryText: queryTextImpl
    }
  })

/**
 * Create a Layer that provides the Claude Agent Client service with direct configuration.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import * as AgentClient from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentClient"
 * import * as Tool from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentTool"
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* AgentClient.ClaudeAgentClient
 *
 *   const result = yield* client.queryText({
 *     prompt: "Hello!"
 *   })
 *
 *   return result
 * })
 *
 * Effect.runPromise(
 *   program.pipe(
 *     Effect.provide(
 *       AgentClient.layer({
 *         apiKeySource: "project",
 *         canUseTool: Tool.allowList(["Read", "Write"])
 *       })
 *     )
 *   )
 * )
 * ```
 *
 * @category Client
 */
export const layer = (options?: AgentConfig.ClaudeAgentConfigOptions): Layer.Layer<ClaudeAgentClient, never, never> =>
  Layer.effect(ClaudeAgentClient, makeClient(AgentConfig.make(options)))

/**
 * Create a Layer that provides the Claude Agent Client service using the config service.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import * as AgentClient from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentClient"
 * import * as AgentConfig from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentConfig"
 *
 * const configLayer = AgentConfig.layer({
 *   apiKeySource: "org",
 *   workingDirectory: "/my/project"
 * })
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* AgentClient.ClaudeAgentClient
 *
 *   const result = yield* client.queryText({
 *     prompt: "What files are in this directory?"
 *   })
 *
 *   return result
 * })
 *
 * Effect.runPromise(
 *   program.pipe(
 *     Effect.provide(AgentClient.layerConfig()),
 *     Effect.provide(configLayer)
 *   )
 * )
 * ```
 *
 * @category Client
 */
export const layerConfig = (): Layer.Layer<ClaudeAgentClient, never, AgentConfig.ClaudeAgentConfig> =>
  Layer.effect(ClaudeAgentClient, Effect.flatMap(AgentConfig.ClaudeAgentConfig, makeClient))

/**
 * Convenience function to execute a query without manually accessing the service.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import * as AgentClient from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentClient"
 *
 * const program = AgentClient.query({ prompt: "Hello!" })
 *
 * Effect.runPromise(
 *   program.pipe(Effect.provide(AgentClient.layer()))
 * )
 * ```
 *
 * @category Client
 */
export const query = (
  options: QueryOptions
): Effect.Effect<
  Stream.Stream<MessageSchemas.MessageEvent, AgentError.AgentError, Scope.Scope>,
  never,
  ClaudeAgentClient
> => Effect.map(ClaudeAgentClient, (client) => client.query(options))

/**
 * Convenience function to execute a query and get text without manually accessing the service.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import * as AgentClient from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentClient"
 *
 * const program = AgentClient.queryText({ prompt: "What is 2+2?" })
 *
 * Effect.runPromise(
 *   program.pipe(Effect.provide(AgentClient.layer()))
 * ).then(console.log)
 * ```
 *
 * @category Client
 */
export const queryText = (
  options: QueryOptions
): Effect.Effect<string, AgentError.AgentError, ClaudeAgentClient | Scope.Scope> =>
  Effect.flatMap(ClaudeAgentClient, (client) => client.queryText(options))
