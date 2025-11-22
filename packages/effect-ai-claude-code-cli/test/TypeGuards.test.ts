/**
 * Tests for type guards module.
 */

import { describe, expect, it } from "vitest"
import {
  ContentBlockStartChunk,
  ContentBlockStopChunk,
  MessageDeltaChunk,
  MessageStartChunk,
  MessageStopChunk,
  TextChunk,
  ToolInputChunk,
  ToolUseStartChunk
} from "../src/StreamEvents.js"
import * as TypeGuards from "../src/TypeGuards.js"

describe("TypeGuards", () => {
  describe("isTextChunk", () => {
    it("should identify text chunk", () => {
      const chunk = new TextChunk({ type: "text", text: "Hello", index: 0 })
      expect(TypeGuards.isTextChunk(chunk)).toBe(true)
    })

    it("should reject non-text chunk", () => {
      const chunk = new MessageStopChunk({ type: "message_stop" })
      expect(TypeGuards.isTextChunk(chunk)).toBe(false)
    })
  })

  describe("isToolUseStartChunk", () => {
    it("should identify tool use start chunk", () => {
      const chunk = new ToolUseStartChunk({
        type: "tool_use_start",
        id: "test-id",
        name: "Read",
        index: 0
      })
      expect(TypeGuards.isToolUseStartChunk(chunk)).toBe(true)
    })

    it("should reject non-tool-use-start chunk", () => {
      const chunk = new TextChunk({ type: "text", text: "Hello", index: 0 })
      expect(TypeGuards.isToolUseStartChunk(chunk)).toBe(false)
    })
  })

  describe("isToolInputChunk", () => {
    it("should identify tool input chunk", () => {
      const chunk = new ToolInputChunk({
        type: "tool_input",
        partialJson: "{}",
        index: 0
      })
      expect(TypeGuards.isToolInputChunk(chunk)).toBe(true)
    })
  })

  describe("isContentBlockStartChunk", () => {
    it("should identify content block start chunk", () => {
      const chunk = new ContentBlockStartChunk({
        type: "content_block_start",
        blockType: "text",
        index: 0
      })
      expect(TypeGuards.isContentBlockStartChunk(chunk)).toBe(true)
    })
  })

  describe("isContentBlockStopChunk", () => {
    it("should identify content block stop chunk", () => {
      const chunk = new ContentBlockStopChunk({
        type: "content_block_stop",
        index: 0
      })
      expect(TypeGuards.isContentBlockStopChunk(chunk)).toBe(true)
    })
  })

  describe("isMessageStartChunk", () => {
    it("should identify message start chunk", () => {
      const chunk = new MessageStartChunk({
        type: "message_start",
        message: {
          id: "msg_123",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-4",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      })
      expect(TypeGuards.isMessageStartChunk(chunk)).toBe(true)
    })
  })

  describe("isMessageDeltaChunk", () => {
    it("should identify message delta chunk", () => {
      const chunk = new MessageDeltaChunk({
        type: "message_delta",
        delta: {
          stop_reason: "end_turn",
          stop_sequence: null
        },
        usage: { output_tokens: 50 }
      })
      expect(TypeGuards.isMessageDeltaChunk(chunk)).toBe(true)
    })
  })

  describe("isMessageStopChunk", () => {
    it("should identify message stop chunk", () => {
      const chunk = new MessageStopChunk({ type: "message_stop" })
      expect(TypeGuards.isMessageStopChunk(chunk)).toBe(true)
    })
  })

  describe("extractUsage", () => {
    it("should extract usage from message delta chunk", () => {
      const chunk = new MessageDeltaChunk({
        type: "message_delta",
        delta: {
          stop_reason: "end_turn",
          stop_sequence: null
        },
        usage: { output_tokens: 50 }
      })
      const usage = TypeGuards.extractUsage(chunk)
      expect(usage).toEqual({ output_tokens: 50 })
    })

    it("should return undefined for non-delta chunks", () => {
      const chunk = new TextChunk({ type: "text", text: "Hello", index: 0 })
      const usage = TypeGuards.extractUsage(chunk)
      expect(usage).toBeUndefined()
    })
  })
})
