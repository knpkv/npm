/**
 * @internal
 * Conversion utilities between SDK types and Effect types.
 */

import { Effect } from "effect"
import * as AgentError from "../ClaudeAgentError.js"
import type * as MessageSchemas from "../MessageSchemas.js"

/**
 * @internal
 * Extract text content from Anthropic SDK message content array.
 */
const extractTextFromContent = (content: any): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  return content
    .filter((block: any) => block?.type === "text")
    .map((block: any) => block.text || "")
    .join("")
}

/**
 * @internal
 * Convert SDK message to MessageEvent.
 */
export const convertSdkMessage = (
  sdkMessage: any
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
            ? apiMessage.content.filter((block: any) => block?.type === "tool_use")
            : undefined

          return {
            type: "assistant" as const,
            content,
            toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined
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
          // SDKResultMessage: result string or errors array
          const content = sdkMessage.result || sdkMessage.errors?.join("\n") || ""
          return {
            type: "result" as const,
            content,
            toolName: undefined
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
      return yield* Effect.fail(
        new AgentError.StreamError({
          message: `Failed to convert SDK message: ${String(error)}`,
          cause: error
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
