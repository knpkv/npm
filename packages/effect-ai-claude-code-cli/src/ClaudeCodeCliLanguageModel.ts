/**
 * LanguageModel integration for Claude Code CLI.
 *
 * @since 1.0.0
 */
import * as AiError from "@effect/ai/AiError"
import * as IdGenerator from "@effect/ai/IdGenerator"
import * as LanguageModel from "@effect/ai/LanguageModel"
import * as AiModel from "@effect/ai/Model"
import type * as Prompt from "@effect/ai/Prompt"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import type { Simplify } from "effect/Types"
import { ClaudeCodeCliClient } from "./ClaudeCodeCliClient.js"
import { ClaudeCodeCliConfig } from "./ClaudeCodeCliConfig.js"
import type { ClaudeCodeCliError } from "./ClaudeCodeCliError.js"

/**
 * Configuration for Claude Code CLI Language Model.
 *
 * @category Configuration
 * @since 1.0.0
 */
export class Config extends Context.Tag("@knpkv/effect-ai-claude-code-cli/ClaudeCodeCliLanguageModel/Config")<
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
 * Create a LanguageModel instance for Claude Code CLI.
 *
 * @param options - Configuration options
 * @returns Effect that yields a LanguageModel
 *
 * @category Constructors
 * @since 1.0.0
 */
export const make = Effect.gen(function*() {
  const client = yield* ClaudeCodeCliClient

  return yield* LanguageModel.make({
    generateText: (providerOptions: LanguageModel.ProviderOptions) =>
      Effect.gen(function*() {
        // Convert prompt to text
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

          // Convert prompt to text
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
 * @since 1.0.0
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
 * @since 1.0.0
 */
export const model = (
  config?: Config.Service
): AiModel.Model<"claude-code-cli", LanguageModel.LanguageModel, ClaudeCodeCliClient> =>
  AiModel.make("claude-code-cli", layer(config))

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
  const messages = Array.isArray(prompt) ? prompt : [prompt]

  for (const message of messages) {
    switch (message.role) {
      case "system": {
        parts.push(`System: ${message.content}`)
        break
      }
      case "user": {
        const contentParts: Array<string> = []

        for (const part of message.content) {
          if (part.type === "text") {
            contentParts.push(part.text)
          } else if (part.type === "image") {
            contentParts.push("[Image content]")
          }
        }

        if (contentParts.length > 0) {
          parts.push(`User: ${contentParts.join("\n")}`)
        }
        break
      }
      case "assistant": {
        const contentParts: Array<string> = []

        for (const part of message.content) {
          if (part.type === "text") {
            contentParts.push(part.text)
          } else if (part.type === "tool-call") {
            contentParts.push(`[Tool call: ${part.name}]`)
          }
        }

        if (contentParts.length > 0) {
          parts.push(`Assistant: ${contentParts.join("\n")}`)
        }
        break
      }
      case "tool": {
        // Include tool results with tool name
        const result = typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content)
        parts.push(`Tool (${message.name}): ${result}`)
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
