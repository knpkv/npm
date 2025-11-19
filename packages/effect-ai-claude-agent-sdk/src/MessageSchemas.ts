/**
 * Schema definitions for Claude Agent SDK message types.
 *
 * @since 1.0.0
 * @category Messages
 */

import { Schema } from "@effect/schema"

/**
 * Message type discriminator.
 *
 * The SDK emits 7 different message types during query execution.
 *
 * @since 1.0.0
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
 * @since 1.0.0
 * @category Messages
 */
export const BaseMessage = Schema.Struct({
  type: MessageType,
  content: Schema.String
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
 * @since 1.0.0
 * @category Messages
 */
export const AssistantMessage = Schema.Struct({
  type: Schema.Literal("assistant"),
  content: Schema.String,
  toolCalls: Schema.optional(Schema.Array(Schema.Unknown))
})

/**
 * User message containing user input.
 *
 * @since 1.0.0
 * @category Messages
 */
export const UserMessage = Schema.Struct({
  type: Schema.Literal("user"),
  content: Schema.String
})

/**
 * Result message containing tool execution results.
 *
 * @since 1.0.0
 * @category Messages
 */
export const ResultMessage = Schema.Struct({
  type: Schema.Literal("result"),
  content: Schema.String,
  toolName: Schema.optional(Schema.String)
})

/**
 * System message containing system-level information.
 *
 * @since 1.0.0
 * @category Messages
 */
export const SystemMessage = Schema.Struct({
  type: Schema.Literal("system"),
  content: Schema.String
})

/**
 * Partial assistant message for streaming responses.
 *
 * @since 1.0.0
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
 * @since 1.0.0
 * @category Messages
 */
export const CompactBoundaryMessage = Schema.Struct({
  type: Schema.Literal("compact_boundary"),
  content: Schema.String
})

/**
 * Permission denial message when tool use is denied.
 *
 * @since 1.0.0
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
 * @since 1.0.0
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
 * @since 1.0.0
 * @category Messages
 */
export type MessageEvent = Schema.Schema.Type<typeof MessageEvent>

/**
 * Type extracted from AssistantMessage schema.
 *
 * @since 1.0.0
 * @category Messages
 */
export type AssistantMessage = Schema.Schema.Type<typeof AssistantMessage>

/**
 * Type extracted from UserMessage schema.
 *
 * @since 1.0.0
 * @category Messages
 */
export type UserMessage = Schema.Schema.Type<typeof UserMessage>

/**
 * Type extracted from ResultMessage schema.
 *
 * @since 1.0.0
 * @category Messages
 */
export type ResultMessage = Schema.Schema.Type<typeof ResultMessage>

/**
 * Type extracted from SystemMessage schema.
 *
 * @since 1.0.0
 * @category Messages
 */
export type SystemMessage = Schema.Schema.Type<typeof SystemMessage>

/**
 * Type extracted from PartialAssistantMessage schema.
 *
 * @since 1.0.0
 * @category Messages
 */
export type PartialAssistantMessage = Schema.Schema.Type<typeof PartialAssistantMessage>

/**
 * Type extracted from CompactBoundaryMessage schema.
 *
 * @since 1.0.0
 * @category Messages
 */
export type CompactBoundaryMessage = Schema.Schema.Type<typeof CompactBoundaryMessage>

/**
 * Type extracted from PermissionDenialMessage schema.
 *
 * @since 1.0.0
 * @category Messages
 */
export type PermissionDenialMessage = Schema.Schema.Type<typeof PermissionDenialMessage>
