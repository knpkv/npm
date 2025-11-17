/**
 * Tests for internal utilities.
 *
 * @since 1.0.0
 */
import { describe, expect, it } from "@effect/vitest"
import { accumulateText, buildCommand, rateLimitSchedule } from "../src/internal/utilities.js"

describe("utilities", () => {
  describe("buildCommand", () => {
    it("should build basic command", () => {
      const command = buildCommand("Hello world")

      expect(command).toBeDefined()
      expect(typeof command).toBe("object")
    })

    it("should build command with model", () => {
      const command = buildCommand("Hello", "claude-sonnet-4-5")

      expect(command).toBeDefined()
    })

    it("should build command with allowed tools", () => {
      const command = buildCommand("Hello", undefined, ["Bash", "Read"])

      expect(command).toBeDefined()
    })

    it("should build command with disallowed tools", () => {
      const command = buildCommand("Hello", undefined, undefined, ["Edit", "Grep"])

      expect(command).toBeDefined()
    })

    it("should build command with all options", () => {
      const command = buildCommand(
        "Hello world",
        "claude-sonnet-4-5",
        ["Bash", "Read"],
        ["Edit"]
      )

      expect(command).toBeDefined()
    })
  })

  describe("rateLimitSchedule", () => {
    it("should be defined", () => {
      expect(rateLimitSchedule).toBeDefined()
    })

    it("should be a schedule", () => {
      expect(typeof rateLimitSchedule).toBe("object")
    })
  })

  describe("accumulateText", () => {
    it("should accumulate text from chunks", () => {
      const chunks = [
        { text: "Hello" },
        { text: " " },
        { text: "world" },
        { text: "!" }
      ]

      const result = accumulateText(chunks)
      expect(result).toBe("Hello world!")
    })

    it("should handle empty chunks", () => {
      const chunks: ReadonlyArray<{ text: string }> = []

      const result = accumulateText(chunks)
      expect(result).toBe("")
    })

    it("should handle single chunk", () => {
      const chunks = [{ text: "Single" }]

      const result = accumulateText(chunks)
      expect(result).toBe("Single")
    })

    it("should handle empty text chunks", () => {
      const chunks = [
        { text: "Hello" },
        { text: "" },
        { text: "world" }
      ]

      const result = accumulateText(chunks)
      expect(result).toBe("Helloworld")
    })
  })
})
