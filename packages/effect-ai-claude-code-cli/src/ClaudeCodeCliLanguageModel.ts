/**
 * LanguageModel integration for Claude Code CLI.
 */
import * as AiError from "@effect/ai/AiError"
import * as IdGenerator from "@effect/ai/IdGenerator"
import * as LanguageModel from "@effect/ai/LanguageModel"
import * as AiModel from "@effect/ai/Model"
import type * as Prompt from "@effect/ai/Prompt"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { Simplify } from "effect/Types"
import { ClaudeCodeCliClient } from "./ClaudeCodeCliClient.js"
import { ClaudeCodeCliConfig } from "./ClaudeCodeCliConfig.js"
import type { ClaudeCodeCliError } from "./ClaudeCodeCliError.js"

/**
 * Configuration for Claude Code CLI Language Model.
 *
 * @category Configuration
 */
export class Config extends Context.Tag("@knpkv/effect-ai-claude-code-cli/ClaudeCodeCliLanguageModel/Config")<
  Config,
  Config.Service
>() {}

/** */
export declare namespace Config {
  /**
   * @category Configuration
   */
  export interface Service extends
    Simplify<{
      readonly model?: string
      readonly allowedTools?: ReadonlyArray<string>
      readonly disallowedTools?: ReadonlyArray<string>
    }>
  {}
}

/**
 * Create a LanguageModel instance for Claude Code CLI.
 *
 * @param options - Configuration options
 * @returns Effect that yields a LanguageModel
 *
 * @category Constructors
 */
export const make = Effect.gen(function*() {
  const client = yield* ClaudeCodeCliClient

  return yield* LanguageModel.make({
    generateText: (providerOptions: LanguageModel.ProviderOptions) =>
      Effect.gen(function*() {
        // Convert prompt to text (handles @effect/ai's {content: [...]} wrapping)
        const promptText = promptToText(providerOptions.prompt)

        // Use basic query for non-streaming text generation
        const responseText = yield* client.query(promptText).pipe(
          Effect.mapError(mapError)
        )

        return [
          {
            type: "text" as const,
            text: responseText
          },
          {
            type: "finish" as const,
            reason: "stop" as const,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0
            }
          }
        ]
      }),

    streamText: (providerOptions: LanguageModel.ProviderOptions) =>
      Stream.unwrap(
        Effect.gen(function*() {
          const idGenerator = yield* IdGenerator.IdGenerator

          // Convert prompt to text (handles @effect/ai's {content: [...]} wrapping)
          const promptText = promptToText(providerOptions.prompt)

          // Use streaming query
          const stream = client.queryStream(promptText)

          return stream.pipe(
            Stream.mapError(mapError),
            Stream.filter((chunk) => chunk.type === "text"),
            Stream.mapEffect((chunk) =>
              Effect.gen(function*() {
                const id = yield* idGenerator.generateId()
                return {
                  type: "text-delta" as const,
                  id,
                  delta: chunk.text
                }
              })
            )
          )
        })
      )
  })
})

/**
 * Layer that provides LanguageModel for Claude Code CLI.
 *
 * @param options - Configuration options
 * @returns Layer providing LanguageModel
 *
 * @example
 * ```typescript
 * import { ClaudeCodeCliLanguageModel, ClaudeCodeCliClient } from "@knpkv/effect-ai-claude-code-cli"
 * import { LanguageModel } from "@effect/ai"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const model = yield* LanguageModel.LanguageModel
 *   const response = yield* model.generateText({
 *     prompt: [{ role: "user", content: "Hello!" }]
 *   })
 *   console.log(response.text)
 * })
 *
 * Effect.runPromise(
 *   program.pipe(
 *     Effect.provide(ClaudeCodeCliLanguageModel.layer({ model: "claude-sonnet-4-5" })),
 *     Effect.provide(ClaudeCodeCliClient.layer())
 *   )
 * )
 * ```
 *
 * @category Layers
 */
export const layer = (
  config?: Config.Service
): Layer.Layer<LanguageModel.LanguageModel, never, ClaudeCodeCliClient> => {
  const configLayer = config
    ? Layer.succeed(ClaudeCodeCliConfig, ClaudeCodeCliConfig.of(config))
    : ClaudeCodeCliConfig.default

  return Layer.effect(LanguageModel.LanguageModel, make).pipe(
    Layer.provide(configLayer),
    Layer.provide(Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator))
  )
}

/**
 * Create an AiModel for Claude Code CLI.
 *
 * @param config - Configuration options
 * @returns AiModel instance
 *
 * @example
 * ```typescript
 * import { ClaudeCodeCliLanguageModel } from "@knpkv/effect-ai-claude-code-cli"
 *
 * const model = ClaudeCodeCliLanguageModel.model({ model: "claude-sonnet-4-5" })
 * ```
 *
 * @category Models
 */
export const model = (
  config?: Config.Service
): AiModel.Model<"claude-code-cli", LanguageModel.LanguageModel, ClaudeCodeCliClient> =>
  AiModel.make("claude-code-cli", layer(config))

/**
 * Schema for message-like objects.
 * Validates basic Message structure without full type information from @effect/ai.
 *
 * @internal
 */
const MessageLikeSchema = Schema.Struct({
  role: Schema.String,
  content: Schema.Unknown
})

type MessageLike = Schema.Schema.Type<typeof MessageLikeSchema>

/**
 * Schema for @effect/ai prompt wrapper structure.
 *
 * @internal
 */
const PromptWrapperSchema = Schema.Struct({
  content: Schema.Array(MessageLikeSchema)
})

/**
 * Schema for array of messages.
 *
 * @internal
 */
const MessageArraySchema = Schema.Array(MessageLikeSchema)

/**
 * Extract messages array from @effect/ai Prompt structure using Schema validation.
 *
 * @effect/ai wraps prompts in {content: [...]} structure at runtime,
 * while the type suggests it could be an array or single message.
 * This helper safely extracts the messages array with runtime validation.
 *
 * @param prompt - The prompt from ProviderOptions
 * @returns Array of messages
 * @internal
 */

const extractMessages = (prompt: Prompt.Prompt): ReadonlyArray<MessageLike> => {
  const wrapperOption = Schema.decodeUnknownOption(PromptWrapperSchema)(prompt)

  return Option.match(wrapperOption, {
    onNone: () => {
      const arrayOption = Schema.decodeUnknownOption(MessageArraySchema)(prompt)
      return Option.match(arrayOption, {
        onNone: () => {
          const messageOption = Schema.decodeUnknownOption(MessageLikeSchema)(prompt)
          return Option.match(messageOption, {
            onNone: () => [],
            onSome: (msg) => [msg]
          })
        },
        onSome: (arr) => arr
      })
    },
    onSome: (wrapper) => wrapper.content
  })
}

/**
 * Type guard for text content part.
 * @internal
 */
const isTextPart = (part: unknown): part is { type: "text"; text: string } =>
  typeof part === "object" && part !== null &&
  "type" in part && part.type === "text" &&
  "text" in part && typeof part.text === "string"

/**
 * Type guard for tool call content part.
 * @internal
 */
const isToolCallPart = (part: unknown): part is { type: "tool-call"; name: string } =>
  typeof part === "object" && part !== null &&
  "type" in part && part.type === "tool-call" &&
  "name" in part && typeof part.name === "string"

/**
 * Convert a Prompt to a text string for Claude Code CLI.
 *
 * Preserves message structure and includes tool messages.
 * Format: "Role: content" with double newline separators.
 *
 * @param prompt - The prompt to convert
 * @returns The formatted prompt text
 * @internal
 */
const promptToText = (prompt: Prompt.Prompt): string => {
  const parts: Array<string> = []
  const messages = extractMessages(prompt)

  for (const message of messages) {
    switch (message.role) {
      case "system": {
        parts.push(`System: ${message.content}`)
        break
      }
      case "user": {
        const contentParts: Array<string> = []

        if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (isTextPart(part)) {
              contentParts.push(part.text)
            } else {
              contentParts.push("[File content]")
            }
          }
        }

        if (contentParts.length > 0) {
          parts.push(`User: ${contentParts.join("\n")}`)
        }
        break
      }
      case "assistant": {
        const contentParts: Array<string> = []

        if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (isTextPart(part)) {
              contentParts.push(part.text)
            } else if (isToolCallPart(part)) {
              contentParts.push(`[Tool call: ${part.name}]`)
            }
          }
        }

        if (contentParts.length > 0) {
          parts.push(`Assistant: ${contentParts.join("\n")}`)
        }
        break
      }
      case "tool": {
        // Include tool results
        const result = typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content)
        // Extract tool name safely
        const nameValue = (message as { name?: unknown }).name
        const toolName = typeof nameValue === "string" ? nameValue : "unknown"
        parts.push(`Tool (${toolName}): ${result}`)
        break
      }
    }
  }

  return parts.join("\n\n")
}

/**
 * Map ClaudeCodeCliError to AiError.
 *
 * @param error - The CLI error
 * @returns Mapped AiError
 * @internal
 */
const mapError = (error: ClaudeCodeCliError): AiError.AiError => {
  const message = "stderr" in error && error.stderr ? error.stderr : error.message

  if (error._tag === "StreamParsingError") {
    return new AiError.MalformedOutput({
      cause: error,
      module: "ClaudeCodeCli",
      method: "query",
      description: message
    })
  }

  return new AiError.UnknownError({
    cause: error,
    module: "ClaudeCodeCli",
    method: "query",
    description: message
  })
}
