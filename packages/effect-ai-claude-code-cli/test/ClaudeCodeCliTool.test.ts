/**
 * Tests for ClaudeCodeCliTool.
 *
 * @since 1.0.0
 */
import { describe, expect, it } from "@effect/vitest"
import { Bash, Edit, getProviderDefinedToolName, Glob, Grep, Read } from "../src/ClaudeCodeCliTool.js"

describe("ClaudeCodeCliTool", () => {
  describe("Tool definitions", () => {
    it("should export Bash tool", () => {
      expect(Bash).toBeDefined()
      expect(typeof Bash).toBe("function")
    })

    it("should export Read tool", () => {
      expect(Read).toBeDefined()
      expect(typeof Read).toBe("function")
    })

    it("should export Edit tool", () => {
      expect(Edit).toBeDefined()
      expect(typeof Edit).toBe("function")
    })

    it("should export Grep tool", () => {
      expect(Grep).toBeDefined()
      expect(typeof Grep).toBe("function")
    })

    it("should export Glob tool", () => {
      expect(Glob).toBeDefined()
      expect(typeof Glob).toBe("function")
    })
  })

  describe("getProviderDefinedToolName", () => {
    it("should return toolkit name for Bash", () => {
      const result = getProviderDefinedToolName("Bash")
      expect(result).toBe("ClaudeCodeCliBash")
    })

    it("should return toolkit name for Read", () => {
      const result = getProviderDefinedToolName("Read")
      expect(result).toBe("ClaudeCodeCliRead")
    })

    it("should return toolkit name for Edit", () => {
      const result = getProviderDefinedToolName("Edit")
      expect(result).toBe("ClaudeCodeCliEdit")
    })

    it("should return toolkit name for Grep", () => {
      const result = getProviderDefinedToolName("Grep")
      expect(result).toBe("ClaudeCodeCliGrep")
    })

    it("should return toolkit name for Glob", () => {
      const result = getProviderDefinedToolName("Glob")
      expect(result).toBe("ClaudeCodeCliGlob")
    })

    it("should return undefined for unknown tool", () => {
      const result = getProviderDefinedToolName("UnknownTool")
      expect(result).toBeUndefined()
    })
  })
})
