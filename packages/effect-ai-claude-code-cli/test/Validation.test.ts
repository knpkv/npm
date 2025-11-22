/**
 * Tests for input validation module.
 */

import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { ValidationError } from "../src/ClaudeCodeCliError.js"
import * as Validation from "../src/Validation.js"

describe("Validation", () => {
  describe("validatePrompt", () => {
    it("should accept valid non-empty prompt", () => {
      const result = Validation.validatePrompt("Hello world").pipe(Effect.runSync)
      expect(result).toBe("Hello world")
    })

    it("should reject prompt with leading/trailing whitespace", () => {
      const result = Validation.validatePrompt("  Hello  ").pipe(
        Effect.flip,
        Effect.runSync
      )
      expect(result).toBeInstanceOf(ValidationError)
      expect(result.message).toContain("trimmed")
    })

    it("should reject empty prompt", () => {
      const result = Validation.validatePrompt("").pipe(
        Effect.flip,
        Effect.runSync
      )
      expect(result).toBeInstanceOf(ValidationError)
      expect(result.message).toContain("Invalid prompt")
    })

    it("should reject whitespace-only prompt", () => {
      const result = Validation.validatePrompt("   ").pipe(
        Effect.flip,
        Effect.runSync
      )
      expect(result).toBeInstanceOf(ValidationError)
    })

    it("should reject extremely long prompt", () => {
      const longPrompt = "a".repeat(Validation.MAX_PROMPT_LENGTH + 1)
      const result = Validation.validatePrompt(longPrompt).pipe(
        Effect.flip,
        Effect.runSync
      )
      expect(result).toBeInstanceOf(ValidationError)
      expect(result.message).toContain("maximum length")
    })

    it("should accept prompt at max length", () => {
      const maxPrompt = "a".repeat(Validation.MAX_PROMPT_LENGTH)
      const result = Validation.validatePrompt(maxPrompt).pipe(Effect.runSync)
      expect(result.length).toBe(Validation.MAX_PROMPT_LENGTH)
    })
  })

  describe("validateModel", () => {
    it("should accept valid claude model", () => {
      const result = Validation.validateModel("claude-4-sonnet-20250514").pipe(Effect.runSync)
      expect(result).toBe("claude-4-sonnet-20250514")
    })

    it("should reject model not starting with claude-", () => {
      const result = Validation.validateModel("gpt-4").pipe(
        Effect.flip,
        Effect.runSync
      )
      expect(result).toBeInstanceOf(ValidationError)
      expect(result.message).toContain("Invalid model ID")
    })

    it("should reject empty model", () => {
      const result = Validation.validateModel("").pipe(
        Effect.flip,
        Effect.runSync
      )
      expect(result).toBeInstanceOf(ValidationError)
    })
  })

  describe("validateToolName", () => {
    it("should accept valid PascalCase tool name", () => {
      const result = Validation.validateToolName("Read").pipe(Effect.runSync)
      expect(result).toBe("Read")
    })

    it("should accept known tool without warning", () => {
      const result = Validation.validateToolName("Bash").pipe(Effect.runSync)
      expect(result).toBe("Bash")
    })

    it("should reject lowercase tool name", () => {
      const result = Validation.validateToolName("read").pipe(
        Effect.flip,
        Effect.runSync
      )
      expect(result).toBeInstanceOf(ValidationError)
    })

    it("should reject tool name with spaces", () => {
      const result = Validation.validateToolName("Read File").pipe(
        Effect.flip,
        Effect.runSync
      )
      expect(result).toBeInstanceOf(ValidationError)
    })

    it("should warn on unknown tool in non-strict mode", () => {
      const result = Validation.validateToolName("UnknownTool").pipe(Effect.runSync)
      expect(result).toBe("UnknownTool")
    })

    it("should reject unknown tool in strict mode", () => {
      const result = Validation.validateToolName("UnknownTool", true).pipe(
        Effect.flip,
        Effect.runSync
      )
      expect(result).toBeInstanceOf(ValidationError)
      expect(result.message).toContain("Unknown tool")
    })
  })

  describe("validateFilePath", () => {
    it("should accept valid file path", () => {
      const result = Validation.validateFilePath("/home/user/file.txt").pipe(Effect.runSync)
      expect(result).toBe("/home/user/file.txt")
    })

    it("should reject path with null byte", () => {
      const result = Validation.validateFilePath("/home/user/\0file.txt").pipe(
        Effect.flip,
        Effect.runSync
      )
      expect(result).toBeInstanceOf(ValidationError)
      expect(result.message).toContain("null bytes")
    })

    it("should reject path with traversal", () => {
      const result = Validation.validateFilePath("/home/../etc/passwd").pipe(
        Effect.flip,
        Effect.runSync
      )
      expect(result).toBeInstanceOf(ValidationError)
      expect(result.message).toContain("path traversal")
    })

    it("should reject empty path", () => {
      const result = Validation.validateFilePath("").pipe(
        Effect.flip,
        Effect.runSync
      )
      expect(result).toBeInstanceOf(ValidationError)
    })
  })

  describe("validateTimeout", () => {
    it("should accept valid timeout", () => {
      const result = Validation.validateTimeout(30000).pipe(Effect.runSync)
      expect(result).toBe(30000)
    })

    it("should accept minimum timeout", () => {
      const result = Validation.validateTimeout(Validation.MIN_TIMEOUT_MS).pipe(Effect.runSync)
      expect(result).toBe(Validation.MIN_TIMEOUT_MS)
    })

    it("should accept maximum timeout", () => {
      const result = Validation.validateTimeout(Validation.MAX_TIMEOUT_MS).pipe(Effect.runSync)
      expect(result).toBe(Validation.MAX_TIMEOUT_MS)
    })

    it("should reject timeout below minimum", () => {
      const result = Validation.validateTimeout(500).pipe(
        Effect.flip,
        Effect.runSync
      )
      expect(result).toBeInstanceOf(ValidationError)
      expect(result.message).toContain("at least")
    })

    it("should reject timeout above maximum", () => {
      const result = Validation.validateTimeout(Validation.MAX_TIMEOUT_MS + 1).pipe(
        Effect.flip,
        Effect.runSync
      )
      expect(result).toBeInstanceOf(ValidationError)
      expect(result.message).toContain("not exceed")
    })
  })

  describe("validateTools", () => {
    it("should validate array of valid tools", () => {
      const result = Validation.validateTools(["Read", "Write", "Bash"]).pipe(Effect.runSync)
      expect(result).toEqual(["Read", "Write", "Bash"])
    })

    it("should reject if any tool is invalid", () => {
      const result = Validation.validateTools(["Read", "invalid", "Write"]).pipe(
        Effect.flip,
        Effect.runSync
      )
      expect(result).toBeInstanceOf(ValidationError)
    })

    it("should handle empty array", () => {
      const result = Validation.validateTools([]).pipe(Effect.runSync)
      expect(result).toEqual([])
    })
  })

  describe("KNOWN_TOOLS consistency", () => {
    it("should match ClaudeCodeCliTool.allTools", async () => {
      // Dynamically import to avoid circular dependencies
      const Tool = await import("../src/ClaudeCodeCliTool.js")

      // KNOWN_TOOLS should have same length and tools as allTools
      expect(Validation.KNOWN_TOOLS.length).toBe(Tool.allTools.length)

      // All tools in allTools should be in KNOWN_TOOLS
      for (const tool of Tool.allTools) {
        expect(Validation.KNOWN_TOOLS).toContain(tool)
      }

      // All tools in KNOWN_TOOLS should be in allTools
      for (const tool of Validation.KNOWN_TOOLS) {
        expect(Tool.allTools).toContain(tool)
      }
    })
  })
})
