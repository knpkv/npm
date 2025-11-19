/**
 * Schema definitions for Claude Agent SDK message types.
 *
 * @category Messages
 */

import { Schema } from "@effect/schema"

/**
 * Message type discriminator.
 *
 * The SDK emits 7 different message types during query execution.
 *
 * @category Messages
 */
export const MessageType = Schema.Literal(
  "assistant",
  "user",
  "result",
  "system",
  "partial_assistant",
  "compact_boundary",
  "permission_denial"
)

/**
 * Base message content.
 *
 * @category Messages
 */
export const BaseMessage = Schema.Struct({
  type: MessageType,
  content: Schema.String
})

/**
 * Token usage information from API response.
 *
 * @category Messages
 */
export const TokenUsage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  cache_creation_input_tokens: Schema.optional(Schema.Number),
  cache_read_input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number)
})

/**
 * Assistant message containing Claude's response.
 *
 * @example
 * ```typescript
 * import { Schema } from "@effect/schema"
 * import * as MessageSchemas from "@knpkv/effect-ai-claude-agent-sdk/MessageSchemas"
 *
 * const message = {
 *   type: "assistant" as const,
 *   content: "Here is my response...",
 *   toolCalls: []
 * }
 *
 * const decoded = Schema.decodeUnknownSync(MessageSchemas.AssistantMessage)(message)
 * ```
 *
 * @category Messages
 */
export const AssistantMessage = Schema.Struct({
  type: Schema.Literal("assistant"),
  content: Schema.String,
  toolCalls: Schema.optional(Schema.Array(Schema.Unknown)),
  usage: Schema.optional(TokenUsage)
})

/**
 * User message containing user input.
 *
 * @category Messages
 */
export const UserMessage = Schema.Struct({
  type: Schema.Literal("user"),
  content: Schema.String
})

/**
 * Session summary with aggregate usage statistics.
 *
 * @category Messages
 */
export const SessionSummary = Schema.Struct({
  duration_ms: Schema.optional(Schema.Number),
  duration_api_ms: Schema.optional(Schema.Number),
  num_turns: Schema.optional(Schema.Number),
  total_cost_usd: Schema.optional(Schema.Number)
})

/**
 * Result message containing tool execution results.
 *
 * @category Messages
 */
export const ResultMessage = Schema.Struct({
  type: Schema.Literal("result"),
  content: Schema.String,
  toolName: Schema.optional(Schema.String),
  usage: Schema.optional(TokenUsage),
  summary: Schema.optional(SessionSummary)
})

/**
 * System message containing system-level information.
 *
 * @category Messages
 */
export const SystemMessage = Schema.Struct({
  type: Schema.Literal("system"),
  content: Schema.String
})

/**
 * Partial assistant message for streaming responses.
 *
 * @category Messages
 */
export const PartialAssistantMessage = Schema.Struct({
  type: Schema.Literal("partial_assistant"),
  content: Schema.String,
  delta: Schema.optional(Schema.String)
})

/**
 * Compact boundary message indicating message boundaries.
 *
 * @category Messages
 */
export const CompactBoundaryMessage = Schema.Struct({
  type: Schema.Literal("compact_boundary"),
  content: Schema.String
})

/**
 * Permission denial message when tool use is denied.
 *
 * @category Messages
 */
export const PermissionDenialMessage = Schema.Struct({
  type: Schema.Literal("permission_denial"),
  content: Schema.String,
  toolName: Schema.optional(Schema.String)
})

/**
 * Union of all possible message types.
 *
 * @example
 * ```typescript
 * import { Effect, Stream } from "effect"
 * import { Schema } from "@effect/schema"
 * import * as MessageSchemas from "@knpkv/effect-ai-claude-agent-sdk/MessageSchemas"
 *
 * const processMessage = (message: MessageSchemas.MessageEvent) => {
 *   switch (message.type) {
 *     case "assistant":
 *       return `Assistant: ${message.content}`
 *     case "user":
 *       return `User: ${message.content}`
 *     case "result":
 *       return `Result: ${message.content}`
 *     case "system":
 *       return `System: ${message.content}`
 *     case "partial_assistant":
 *       return `Partial: ${message.content}`
 *     case "compact_boundary":
 *       return "Boundary"
 *     case "permission_denial":
 *       return `Denied: ${message.content}`
 *   }
 * }
 * ```
 *
 * @category Messages
 */
export const MessageEvent = Schema.Union(
  AssistantMessage,
  UserMessage,
  ResultMessage,
  SystemMessage,
  PartialAssistantMessage,
  CompactBoundaryMessage,
  PermissionDenialMessage
)

/**
 * Type extracted from MessageEvent schema.
 *
 * @category Messages
 */
export type MessageEvent = Schema.Schema.Type<typeof MessageEvent>

/**
 * Type extracted from TokenUsage schema.
 *
 * @category Messages
 */
export type TokenUsage = Schema.Schema.Type<typeof TokenUsage>

/**
 * Type extracted from SessionSummary schema.
 *
 * @category Messages
 */
export type SessionSummary = Schema.Schema.Type<typeof SessionSummary>

/**
 * Type extracted from AssistantMessage schema.
 *
 * @category Messages
 */
export type AssistantMessage = Schema.Schema.Type<typeof AssistantMessage>

/**
 * Type extracted from UserMessage schema.
 *
 * @category Messages
 */
export type UserMessage = Schema.Schema.Type<typeof UserMessage>

/**
 * Type extracted from ResultMessage schema.
 *
 * @category Messages
 */
export type ResultMessage = Schema.Schema.Type<typeof ResultMessage>

/**
 * Type extracted from SystemMessage schema.
 *
 * @category Messages
 */
export type SystemMessage = Schema.Schema.Type<typeof SystemMessage>

/**
 * Type extracted from PartialAssistantMessage schema.
 *
 * @category Messages
 */
export type PartialAssistantMessage = Schema.Schema.Type<typeof PartialAssistantMessage>

/**
 * Type extracted from CompactBoundaryMessage schema.
 *
 * @category Messages
 */
export type CompactBoundaryMessage = Schema.Schema.Type<typeof CompactBoundaryMessage>

/**
 * Type extracted from PermissionDenialMessage schema.
 *
 * @category Messages
 */
export type PermissionDenialMessage = Schema.Schema.Type<typeof PermissionDenialMessage>
