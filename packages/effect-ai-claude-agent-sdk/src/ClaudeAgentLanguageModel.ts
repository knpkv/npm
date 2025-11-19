/**
 * LanguageModel integration for Claude Agent SDK.
 *
 * @since 1.0.0
 */
import * as AiError from "@effect/ai/AiError"
import * as IdGenerator from "@effect/ai/IdGenerator"
import * as LanguageModel from "@effect/ai/LanguageModel"
import * as AiModel from "@effect/ai/Model"
import type * as Prompt from "@effect/ai/Prompt"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import type { Simplify } from "effect/Types"
import * as AgentClient from "./ClaudeAgentClient.js"
import * as AgentConfig from "./ClaudeAgentConfig.js"
import type * as AgentError from "./ClaudeAgentError.js"

/**
 * Configuration for Claude Agent Language Model.
 *
 * @category Configuration
 * @since 1.0.0
 */
export class Config extends Context.Tag("@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentLanguageModel/Config")<
  Config,
  Config.Service
>() {}

/**
 * @since 1.0.0
 */
export declare namespace Config {
  /**
   * @category Configuration
   * @since 1.0.0
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
 * Create a LanguageModel instance for Claude Agent SDK.
 *
 * @param options - Configuration options
 * @returns Effect that yields a LanguageModel
 *
 * @category Constructors
 * @since 1.0.0
 */
export const make = Effect.gen(function*() {
  const client = yield* AgentClient.ClaudeAgentClient

  return yield* LanguageModel.make({
    generateText: (providerOptions: LanguageModel.ProviderOptions) =>
      Effect.gen(function*() {
        // Convert prompt to text
        const promptText = promptToText(providerOptions.prompt)

        // Use queryText for non-streaming text generation
        const responseText = yield* client.queryText({
          prompt: promptText
        }).pipe(
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

          // Convert prompt to text
          const promptText = promptToText(providerOptions.prompt)

          // Use streaming query
          const stream = client.query({
            prompt: promptText
          })

          return stream.pipe(
            Stream.mapError(mapError),
            Stream.filter((message) => message.type === "assistant"),
            Stream.filter((message) => message.content.length > 0),
            Stream.mapEffect((message) =>
              Effect.map(idGenerator.generateId(), (id) => ({
                type: "text-delta" as const,
                id,
                delta: message.content
              }))
            )
          )
        })
      )
  })
})

/**
 * Layer that provides LanguageModel for Claude Agent SDK.
 *
 * @param options - Configuration options
 * @returns Layer providing LanguageModel
 *
 * @example
 * ```typescript
 * import { ClaudeAgentLanguageModel, ClaudeAgentClient } from "@knpkv/effect-ai-claude-agent-sdk"
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
 *     Effect.provide(ClaudeAgentLanguageModel.layer()),
 *     Effect.provide(ClaudeAgentClient.layer())
 *   )
 * )
 * ```
 *
 * @category Layers
 * @since 1.0.0
 */
export const layer = (
  config?: Config.Service
): Layer.Layer<LanguageModel.LanguageModel, never, AgentClient.ClaudeAgentClient> => {
  const configLayer = config
    ? AgentConfig.layer(config)
    : AgentConfig.layer()

  return Layer.effect(LanguageModel.LanguageModel, make).pipe(
    Layer.provide(configLayer),
    Layer.provide(Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator))
  )
}

/**
 * Create an AiModel for Claude Agent SDK.
 *
 * @param config - Configuration options
 * @returns AiModel instance
 *
 * @example
 * ```typescript
 * import { ClaudeAgentLanguageModel } from "@knpkv/effect-ai-claude-agent-sdk"
 *
 * const model = ClaudeAgentLanguageModel.model()
 * ```
 *
 * @category Models
 * @since 1.0.0
 */
export const model = (
  config?: Config.Service
): AiModel.Model<"claude-agent-sdk", LanguageModel.LanguageModel, AgentClient.ClaudeAgentClient> =>
  AiModel.make("claude-agent-sdk", layer(config))

/**
 * Schema for message-like objects.
 * @internal
 */
const MessageLikeSchema = Schema.Struct({
  role: Schema.String,
  content: Schema.Unknown
})

type MessageLike = Schema.Schema.Type<typeof MessageLikeSchema>

/**
 * Schema for @effect/ai prompt wrapper structure.
 * @internal
 */
const PromptWrapperSchema = Schema.Struct({
  content: Schema.Array(MessageLikeSchema)
})

/**
 * Schema for array of messages.
 * @internal
 */
const MessageArraySchema = Schema.Array(MessageLikeSchema)

/**
 * Extract messages array from @effect/ai Prompt structure.
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
 * Convert a Prompt to a text string for Claude Agent SDK.
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
        const result = typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content)
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
 * Map AgentError to AiError.
 * @internal
 */
const mapError = (error: AgentError.AgentError): AiError.AiError => {
  const message = error.message

  if (error._tag === "StreamError") {
    return new AiError.MalformedOutput({
      cause: error,
      module: "ClaudeAgentSDK",
      method: "query",
      description: message
    })
  }

  return new AiError.UnknownError({
    cause: error,
    module: "ClaudeAgentSDK",
    method: "query",
    description: message
  })
}
