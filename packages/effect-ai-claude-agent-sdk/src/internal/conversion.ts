/**
 * @internal
 * Conversion utilities between SDK types and Effect types.
 */

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect } from "effect"
import * as AgentError from "../ClaudeAgentError.js"
import type * as MessageSchemas from "../MessageSchemas.js"

/**
 * Type guard for text content blocks.
 */
const isTextBlock = (block: unknown): block is { type: "text"; text: string } =>
  typeof block === "object" &&
  block !== null &&
  "type" in block &&
  block.type === "text" &&
  "text" in block &&
  typeof block.text === "string"

/**
 * Type guard for tool_use content blocks.
 */
const isToolUseBlock = (block: unknown): block is { type: "tool_use" } =>
  typeof block === "object" &&
  block !== null &&
  "type" in block &&
  block.type === "tool_use"

/**
 * @internal
 * Extract text content from Anthropic SDK message content array.
 */
const extractTextFromContent = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  return content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join("")
}

/**
 * @internal
 * Convert SDK message to MessageEvent.
 */
export const convertSdkMessage = (
  sdkMessage: SDKMessage
): Effect.Effect<MessageSchemas.MessageEvent, AgentError.StreamError> =>
  Effect.gen(function*() {
    try {
      // SDK messages have a type field that maps to our MessageType
      const messageType = sdkMessage.type

      // Create message event based on type
      switch (messageType) {
        case "assistant": {
          // SDKAssistantMessage: content is in sdkMessage.message.content
          const apiMessage = sdkMessage.message
          const content = extractTextFromContent(apiMessage?.content)

          // Extract tool_use blocks from content array
          const toolCalls = Array.isArray(apiMessage?.content)
            ? apiMessage.content.filter(isToolUseBlock)
            : undefined

          // Extract token usage if available
          const usage = apiMessage?.usage ?
            {
              input_tokens: apiMessage.usage.input_tokens,
              cache_creation_input_tokens: apiMessage.usage.cache_creation_input_tokens,
              cache_read_input_tokens: apiMessage.usage.cache_read_input_tokens,
              output_tokens: apiMessage.usage.output_tokens
            } :
            undefined

          return {
            type: "assistant" as const,
            content,
            toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
            usage
          }
        }

        case "user": {
          // SDKUserMessage: content is in sdkMessage.message
          const apiMessage = sdkMessage.message
          const content = extractTextFromContent(apiMessage?.content)
          return {
            type: "user" as const,
            content
          }
        }

        case "result": {
          // SDKResultMessage: discriminated union based on subtype
          const isSuccess = sdkMessage.subtype === "success"

          // Build content with enhanced error details for error results
          const content = isSuccess
            ? sdkMessage.result
            : sdkMessage.errors && sdkMessage.errors.length > 0
            ? `${sdkMessage.subtype}\n\nErrors:\n${sdkMessage.errors.map((e, i) => `${i + 1}. ${e}`).join("\n")}`
            : sdkMessage.errors.join("\n")

          // Extract aggregate usage and session summary
          const usage = {
            input_tokens: sdkMessage.usage.input_tokens,
            cache_creation_input_tokens: sdkMessage.usage.cache_creation_input_tokens,
            cache_read_input_tokens: sdkMessage.usage.cache_read_input_tokens,
            output_tokens: sdkMessage.usage.output_tokens
          }

          const summary = {
            duration_ms: sdkMessage.duration_ms,
            duration_api_ms: sdkMessage.duration_api_ms,
            num_turns: sdkMessage.num_turns,
            total_cost_usd: sdkMessage.total_cost_usd
          }

          return {
            type: "result" as const,
            content,
            toolName: undefined,
            usage,
            summary
          }
        }

        case "system": {
          // SDKSystemMessage: format system info
          if (sdkMessage.subtype === "init") {
            const parts = [
              `Model: ${sdkMessage.model}`,
              `Tools: ${sdkMessage.tools?.join(", ")}`,
              `CWD: ${sdkMessage.cwd}`
            ]
            return {
              type: "system" as const,
              content: parts.join("\n")
            }
          }
          return {
            type: "system" as const,
            content: JSON.stringify(sdkMessage.subtype || "system")
          }
        }

        case "stream_event": {
          // SDKPartialAssistantMessage: extract from event
          const event = sdkMessage.event
          if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
            return {
              type: "partial_assistant" as const,
              content: event.delta.text || "",
              delta: event.delta
            }
          }
          return {
            type: "partial_assistant" as const,
            content: "",
            delta: event
          }
        }

        case "tool_progress": {
          // SDKToolProgressMessage
          const content = `Tool: ${sdkMessage.tool_name} (${sdkMessage.elapsed_time_seconds}s)`
          return {
            type: "system" as const,
            content
          }
        }

        default:
          // Unknown message type, treat as system message
          return {
            type: "system" as const,
            content: JSON.stringify(sdkMessage)
          }
      }
    } catch (error) {
      const messageType = sdkMessage.type
      const errorMessage = error instanceof Error ? error.message : String(error)
      const errorSubtype = sdkMessage.type === "result" && sdkMessage.subtype !== "success"
        ? sdkMessage.subtype
        : undefined
      const errors = sdkMessage.type === "result" && sdkMessage.subtype !== "success"
        ? sdkMessage.errors
        : undefined

      return yield* Effect.fail(
        new AgentError.StreamError({
          message: `Failed to convert SDK message of type '${messageType}': ${errorMessage}`,
          cause: error,
          ...(errorSubtype !== undefined && { errorSubtype }),
          ...(errors !== undefined && { errors })
        })
      )
    }
  })

/**
 * @internal
 * Convert prompt string to SDK message format.
 */
export const convertPromptToSdkFormat = (prompt: string): string => prompt

/**
 * @internal
 * Collect assistant messages from stream and concatenate.
 */
export const collectAssistantText = (messages: ReadonlyArray<MessageSchemas.MessageEvent>): string =>
  messages
    .filter((m): m is MessageSchemas.AssistantMessage => m.type === "assistant")
    .map((m) => m.content)
    .join("")
