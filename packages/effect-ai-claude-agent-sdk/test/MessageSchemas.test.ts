/**
 * Unit tests for MessageSchemas.
 */
import { Schema } from "@effect/schema"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as MessageSchemas from "../src/MessageSchemas.js"

describe("MessageSchemas", () => {
  describe("AssistantMessage", () => {
    it("should validate assistant message with content", async () => {
      const message: MessageSchemas.MessageEvent = {
        type: "assistant",
        content: "Hello, world!"
      }

      const result = await Effect.runPromise(
        Schema.decodeUnknown(MessageSchemas.MessageEvent)(message)
      )

      expect(result).toEqual(message)
    })

    it("should validate assistant message with tool calls", async () => {
      const message: MessageSchemas.MessageEvent = {
        type: "assistant",
        content: "Using tools",
        toolCalls: [
          {
            type: "tool_use",
            id: "tool1",
            name: "Read",
            input: { file: "test.txt" }
          }
        ]
      }

      const result = await Effect.runPromise(
        Schema.decodeUnknown(MessageSchemas.MessageEvent)(message)
      )

      expect(result).toEqual(message)
    })

    it("should validate assistant message with empty content", async () => {
      const message: MessageSchemas.MessageEvent = {
        type: "assistant",
        content: ""
      }

      const result = await Effect.runPromise(
        Schema.decodeUnknown(MessageSchemas.MessageEvent)(message)
      )

      expect(result).toEqual(message)
    })
  })

  describe("UserMessage", () => {
    it("should validate user message", async () => {
      const message: MessageSchemas.MessageEvent = {
        type: "user",
        content: "Hello, assistant!"
      }

      const result = await Effect.runPromise(
        Schema.decodeUnknown(MessageSchemas.MessageEvent)(message)
      )

      expect(result).toEqual(message)
    })
  })

  describe("MessageEvent union", () => {
    it("should validate different message types", async () => {
      const messages: Array<MessageSchemas.MessageEvent> = [
        { type: "assistant", content: "Assistant message" },
        { type: "user", content: "User message" },
        {
          type: "assistant",
          content: "Tool call",
          toolCalls: [{ type: "tool_use", id: "1", name: "Read", input: {} }]
        }
      ]

      for (const message of messages) {
        const result = await Effect.runPromise(
          Schema.decodeUnknown(MessageSchemas.MessageEvent)(message)
        )
        expect(result).toEqual(message)
      }
    })

    it("should reject invalid message type", async () => {
      const invalidMessage = {
        type: "invalid",
        content: "test"
      }

      const exit = await Effect.runPromiseExit(
        Schema.decodeUnknown(MessageSchemas.MessageEvent)(invalidMessage)
      )

      expect(exit._tag).toBe("Failure")
    })

    it("should reject message without type", async () => {
      const invalidMessage = {
        content: "test"
      }

      const exit = await Effect.runPromiseExit(
        Schema.decodeUnknown(MessageSchemas.MessageEvent)(invalidMessage)
      )

      expect(exit._tag).toBe("Failure")
    })

    it("should reject message without content", async () => {
      const invalidMessage = {
        type: "assistant"
      }

      const exit = await Effect.runPromiseExit(
        Schema.decodeUnknown(MessageSchemas.MessageEvent)(invalidMessage)
      )

      expect(exit._tag).toBe("Failure")
    })
  })

  describe("ToolCall", () => {
    it("should validate tool call with all fields", async () => {
      const toolCall = {
        type: "tool_use",
        id: "tool123",
        name: "Read",
        input: { file: "package.json", path: "/test" }
      }

      const message: MessageSchemas.MessageEvent = {
        type: "assistant",
        content: "Reading file",
        toolCalls: [toolCall]
      }

      const result = await Effect.runPromise(
        Schema.decodeUnknown(MessageSchemas.MessageEvent)(message)
      )

      expect(result.toolCalls).toEqual([toolCall])
    })

    it("should validate tool call with empty input", async () => {
      const toolCall = {
        type: "tool_use",
        id: "tool123",
        name: "Read",
        input: {}
      }

      const message: MessageSchemas.MessageEvent = {
        type: "assistant",
        content: "",
        toolCalls: [toolCall]
      }

      const result = await Effect.runPromise(
        Schema.decodeUnknown(MessageSchemas.MessageEvent)(message)
      )

      expect(result.toolCalls).toEqual([toolCall])
    })

    it("should validate multiple tool calls", async () => {
      const toolCalls = [
        { type: "tool_use", id: "1", name: "Read", input: { file: "a.txt" } },
        { type: "tool_use", id: "2", name: "Write", input: { file: "b.txt", content: "test" } },
        { type: "tool_use", id: "3", name: "Grep", input: { pattern: "test" } }
      ]

      const message: MessageSchemas.MessageEvent = {
        type: "assistant",
        content: "Using tools",
        toolCalls
      }

      const result = await Effect.runPromise(
        Schema.decodeUnknown(MessageSchemas.MessageEvent)(message)
      )

      expect(result.toolCalls).toEqual(toolCalls)
    })
  })

  describe("Type safety", () => {
    it("should provide proper type inference for assistant messages", () => {
      const message: MessageSchemas.MessageEvent = {
        type: "assistant",
        content: "test"
      }

      if (message.type === "assistant") {
        // TypeScript should know toolCalls is optional here
        const toolCalls = message.toolCalls
        expect(toolCalls).toBeUndefined()
      }
    })

    it("should provide proper type inference for user messages", () => {
      const message: MessageSchemas.MessageEvent = {
        type: "user",
        content: "test"
      }

      if (message.type === "user") {
        // TypeScript should know only content is available
        const content = message.content
        expect(content).toBe("test")
      }
    })
  })
})
