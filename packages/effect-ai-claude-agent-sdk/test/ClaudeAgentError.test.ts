/**
 * Unit tests for ClaudeAgentError.
 */
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentError from "../src/ClaudeAgentError.js"

describe("ClaudeAgentError", () => {
  describe("SdkError", () => {
    it("should create SDK error with message", () => {
      const error = new AgentError.SdkError({ message: "SDK failed" })

      expect(error).toBeInstanceOf(AgentError.SdkError)
      expect(error.message).toBe("SDK failed")
      expect(error._tag).toBe("SdkError")
    })

    it("should create SDK error with cause", () => {
      const cause = new Error("Root cause")
      const error = new AgentError.SdkError({ message: "SDK failed", cause })

      expect(error.message).toBe("SDK failed")
      expect(error.cause).toBe(cause)
    })

    it("should be catchable with catchTag", async () => {
      const program = Effect.fail(new AgentError.SdkError({ message: "Test error" })).pipe(
        Effect.catchTag("SdkError", (error) => Effect.succeed(`Caught: ${error.message}`))
      )

      const result = await Effect.runPromise(program)

      expect(result).toBe("Caught: Test error")
    })
  })

  describe("StreamError", () => {
    it("should create stream error with message", () => {
      const error = new AgentError.StreamError({ message: "Stream failed" })

      expect(error).toBeInstanceOf(AgentError.StreamError)
      expect(error.message).toBe("Stream failed")
      expect(error._tag).toBe("StreamError")
    })

    it("should be catchable with catchTag", async () => {
      const program = Effect.fail(new AgentError.StreamError({ message: "Stream error" })).pipe(
        Effect.catchTag("StreamError", (error) => Effect.succeed(`Caught: ${error.message}`))
      )

      const result = await Effect.runPromise(program)

      expect(result).toBe("Caught: Stream error")
    })
  })

  describe("ToolError", () => {
    it("should create tool error with message", () => {
      const error = new AgentError.ToolError({ message: "Tool execution failed" })

      expect(error).toBeInstanceOf(AgentError.ToolError)
      expect(error.message).toBe("Tool execution failed")
      expect(error._tag).toBe("ToolError")
    })

    it("should be catchable with catchTag", async () => {
      const program = Effect.fail(new AgentError.ToolError({ message: "Tool error" })).pipe(
        Effect.catchTag("ToolError", (error) => Effect.succeed(`Caught: ${error.message}`))
      )

      const result = await Effect.runPromise(program)

      expect(result).toBe("Caught: Tool error")
    })
  })

  describe("ValidationError", () => {
    it("should create validation error with message", () => {
      const error = new AgentError.ValidationError({ message: "Invalid input" })

      expect(error).toBeInstanceOf(AgentError.ValidationError)
      expect(error.message).toBe("Invalid input")
      expect(error._tag).toBe("ValidationError")
    })

    it("should be catchable with catchTag", async () => {
      const program = Effect.fail(new AgentError.ValidationError({ message: "Validation error" })).pipe(
        Effect.catchTag("ValidationError", (error) => Effect.succeed(`Caught: ${error.message}`))
      )

      const result = await Effect.runPromise(program)

      expect(result).toBe("Caught: Validation error")
    })
  })

  describe("PermissionError", () => {
    it("should create permission error with message", () => {
      const error = new AgentError.PermissionError({ message: "Permission denied" })

      expect(error).toBeInstanceOf(AgentError.PermissionError)
      expect(error.message).toBe("Permission denied")
      expect(error._tag).toBe("PermissionError")
    })

    it("should be catchable with catchTag", async () => {
      const program = Effect.fail(new AgentError.PermissionError({ message: "Permission error" })).pipe(
        Effect.catchTag("PermissionError", (error) => Effect.succeed(`Caught: ${error.message}`))
      )

      const result = await Effect.runPromise(program)

      expect(result).toBe("Caught: Permission error")
    })
  })

  describe("AgentError union", () => {
    it("should handle any agent error type", async () => {
      const handleError = (error: AgentError.AgentError) => {
        switch (error._tag) {
          case "SdkError":
            return `SDK: ${error.message}`
          case "StreamError":
            return `Stream: ${error.message}`
          case "ToolError":
            return `Tool: ${error.message}`
          case "ValidationError":
            return `Validation: ${error.message}`
          case "PermissionError":
            return `Permission: ${error.message}`
        }
      }

      const sdkError = new AgentError.SdkError({ message: "test" })
      const streamError = new AgentError.StreamError({ message: "test" })
      const toolError = new AgentError.ToolError({ message: "test" })
      const validationError = new AgentError.ValidationError({ message: "test" })
      const permissionError = new AgentError.PermissionError({ message: "test" })

      expect(handleError(sdkError)).toBe("SDK: test")
      expect(handleError(streamError)).toBe("Stream: test")
      expect(handleError(toolError)).toBe("Tool: test")
      expect(handleError(validationError)).toBe("Validation: test")
      expect(handleError(permissionError)).toBe("Permission: test")
    })
  })

  describe("Error composition", () => {
    it("should compose multiple error handlers", async () => {
      const program = Effect.gen(function*() {
        const randomError = Math.random() > 0.5
        if (randomError) {
          return yield* Effect.fail(new AgentError.SdkError({ message: "SDK error" }))
        } else {
          return yield* Effect.fail(new AgentError.ValidationError({ message: "Validation error" }))
        }
      }).pipe(
        Effect.catchTags({
          SdkError: (error) => Effect.succeed(`Recovered from SDK: ${error.message}`),
          ValidationError: (error) => Effect.succeed(`Recovered from validation: ${error.message}`)
        })
      )

      const result = await Effect.runPromise(program)

      expect(result).toMatch(/^Recovered from (SDK|validation):/)
    })
  })
})
