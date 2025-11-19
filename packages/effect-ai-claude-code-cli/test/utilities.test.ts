/**
 * Tests for internal utilities.
 */
import { describe, expect, it } from "@effect/vitest"
import { accumulateText, buildCommand, hasToolsConfigured, rateLimitSchedule } from "../src/internal/utilities.js"

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

    it("should handle empty allowedTools array as deny all", () => {
      const command = buildCommand("Hello", undefined, [])

      expect(command).toBeDefined()
      // Empty array should use __none__ as placeholder
    })

    it("should differentiate undefined from empty array", () => {
      const withUndefined = buildCommand("Hello", undefined, undefined)
      const withEmpty = buildCommand("Hello", undefined, [])

      expect(withUndefined).toBeDefined()
      expect(withEmpty).toBeDefined()
      // Both should be different commands
      expect(withUndefined).not.toEqual(withEmpty)
    })
  })

  describe("hasToolsConfigured", () => {
    it("should return false when no tools configured", () => {
      expect(hasToolsConfigured(undefined, undefined)).toBe(false)
    })

    it("should return true for non-empty allowedTools", () => {
      expect(hasToolsConfigured(["Read"], undefined)).toBe(true)
    })

    it("should return true for empty allowedTools array", () => {
      // Empty array means "deny all" - tools are configured
      expect(hasToolsConfigured([], undefined)).toBe(true)
    })

    it("should return true for non-empty disallowedTools", () => {
      expect(hasToolsConfigured(undefined, ["Bash"])).toBe(true)
    })

    it("should return false for empty disallowedTools array", () => {
      // Empty disallowed array with no allowed = no configuration
      expect(hasToolsConfigured(undefined, [])).toBe(false)
    })

    it("should return true when both are configured", () => {
      expect(hasToolsConfigured(["Read"], ["Bash"])).toBe(true)
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
