/**
 * Type guards and type utilities for working with message chunks.
 */

import type {
  ContentBlockStartChunk,
  ContentBlockStopChunk,
  MessageChunk,
  MessageDeltaChunk,
  MessageStartChunk,
  MessageStopChunk,
  TextChunk,
  ToolInputChunk,
  ToolUseStartChunk
} from "./StreamEvents.js"

/**
 * Type guard for TextChunk.
 *
 * @param chunk - Message chunk to check
 * @returns True if chunk is a TextChunk
 *
 * @category Type Guards
 * @example
 *   import { isTextChunk } from "@knpkv/effect-ai-claude-code-cli/TypeGuards"
 *
 *   stream.pipe(
 *     Stream.filter(isTextChunk),
 *     Stream.map(chunk => chunk.text)
 *   )
 */
export const isTextChunk = (chunk: MessageChunk): chunk is TextChunk => chunk.type === "text"

/**
 * Type guard for ToolUseStartChunk.
 *
 * @param chunk - Message chunk to check
 * @returns True if chunk is a ToolUseStartChunk
 *
 * @category Type Guards
 */
export const isToolUseStartChunk = (chunk: MessageChunk): chunk is ToolUseStartChunk => chunk.type === "tool_use_start"

/**
 * Type guard for ToolInputChunk.
 *
 * @param chunk - Message chunk to check
 * @returns True if chunk is a ToolInputChunk
 *
 * @category Type Guards
 */
export const isToolInputChunk = (chunk: MessageChunk): chunk is ToolInputChunk => chunk.type === "tool_input"

/**
 * Type guard for ContentBlockStartChunk.
 *
 * @param chunk - Message chunk to check
 * @returns True if chunk is a ContentBlockStartChunk
 *
 * @category Type Guards
 */
export const isContentBlockStartChunk = (chunk: MessageChunk): chunk is ContentBlockStartChunk =>
  chunk.type === "content_block_start"

/**
 * Type guard for ContentBlockStopChunk.
 *
 * @param chunk - Message chunk to check
 * @returns True if chunk is a ContentBlockStopChunk
 *
 * @category Type Guards
 */
export const isContentBlockStopChunk = (chunk: MessageChunk): chunk is ContentBlockStopChunk =>
  chunk.type === "content_block_stop"

/**
 * Type guard for MessageStartChunk.
 *
 * @param chunk - Message chunk to check
 * @returns True if chunk is a MessageStartChunk
 *
 * @category Type Guards
 */
export const isMessageStartChunk = (chunk: MessageChunk): chunk is MessageStartChunk => chunk.type === "message_start"

/**
 * Type guard for MessageDeltaChunk.
 *
 * @param chunk - Message chunk to check
 * @returns True if chunk is a MessageDeltaChunk
 *
 * @category Type Guards
 */
export const isMessageDeltaChunk = (chunk: MessageChunk): chunk is MessageDeltaChunk => chunk.type === "message_delta"

/**
 * Type guard for MessageStopChunk.
 *
 * @param chunk - Message chunk to check
 * @returns True if chunk is a MessageStopChunk
 *
 * @category Type Guards
 */
export const isMessageStopChunk = (chunk: MessageChunk): chunk is MessageStopChunk => chunk.type === "message_stop"

/**
 * Extract all text chunks from a stream.
 *
 * @category Utilities
 * @example
 *   import { extractTextChunks } from "@knpkv/effect-ai-claude-code-cli/TypeGuards"
 *   import { Stream } from "effect"
 *
 *   const textStream = stream.pipe(
 *     Stream.filterMap(extractTextChunks)
 *   )
 */
export const extractTextChunks = (chunk: MessageChunk): chunk is TextChunk => isTextChunk(chunk)

/**
 * Extract usage information from message delta chunks.
 *
 * @param chunk - Message chunk
 * @returns Usage object if chunk is MessageDeltaChunk, undefined otherwise
 *
 * @category Utilities
 * @example
 *   import { extractUsage } from "@knpkv/effect-ai-claude-code-cli/TypeGuards"
 *
 *   const usage = stream.pipe(
 *     Stream.filterMap(extractUsage),
 *     Stream.runLast
 *   )
 */
export const extractUsage = (chunk: MessageChunk) => isMessageDeltaChunk(chunk) ? chunk.usage : undefined
