/**
 * Unit tests for ClaudeAgentTool.
 */
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Tool from "../src/ClaudeAgentTool.js"

describe("ClaudeAgentTool", () => {
  describe("allTools", () => {
    it("should contain 16 built-in tools", () => {
      expect(Tool.allTools).toHaveLength(16)
    })

    it("should include common tools", () => {
      expect(Tool.allTools).toContain("Read")
      expect(Tool.allTools).toContain("Write")
      expect(Tool.allTools).toContain("Edit")
      expect(Tool.allTools).toContain("Bash")
      expect(Tool.allTools).toContain("Glob")
      expect(Tool.allTools).toContain("Grep")
    })

    it("should include all expected tools", () => {
      const expected = [
        "Read",
        "Write",
        "Edit",
        "Bash",
        "Glob",
        "Grep",
        "WebSearch",
        "WebFetch",
        "Task",
        "SlashCommand",
        "Skill",
        "TodoWrite",
        "AskUserQuestion",
        "NotebookEdit",
        "BashOutput",
        "KillShell"
      ]

      expect(Tool.allTools).toEqual(expected)
    })
  })

  describe("allowAll", () => {
    it("should allow any tool", async () => {
      const result1 = await Effect.runPromise(Tool.allowAll("Read"))
      const result2 = await Effect.runPromise(Tool.allowAll("Bash"))
      const result3 = await Effect.runPromise(Tool.allowAll("CustomTool"))

      expect(result1).toBe(true)
      expect(result2).toBe(true)
      expect(result3).toBe(true)
    })
  })

  describe("denyAll", () => {
    it("should deny any tool", async () => {
      const result1 = await Effect.runPromise(Tool.denyAll("Read"))
      const result2 = await Effect.runPromise(Tool.denyAll("Bash"))
      const result3 = await Effect.runPromise(Tool.denyAll("CustomTool"))

      expect(result1).toBe(false)
      expect(result2).toBe(false)
      expect(result3).toBe(false)
    })
  })

  describe("allowList", () => {
    it("should allow only specified tools", async () => {
      const canUse = Tool.allowList(["Read", "Write", "Edit"])

      const allowed1 = await Effect.runPromise(canUse("Read"))
      const allowed2 = await Effect.runPromise(canUse("Write"))
      const denied1 = await Effect.runPromise(canUse("Bash"))
      const denied2 = await Effect.runPromise(canUse("Grep"))

      expect(allowed1).toBe(true)
      expect(allowed2).toBe(true)
      expect(denied1).toBe(false)
      expect(denied2).toBe(false)
    })

    it("should work with empty list", async () => {
      const canUse = Tool.allowList([])

      const result1 = await Effect.runPromise(canUse("Read"))
      const result2 = await Effect.runPromise(canUse("Write"))

      expect(result1).toBe(false)
      expect(result2).toBe(false)
    })

    it("should work with custom tool names", async () => {
      const canUse = Tool.allowList(["CustomTool1", "CustomTool2"])

      const allowed = await Effect.runPromise(canUse("CustomTool1"))
      const denied = await Effect.runPromise(canUse("Read"))

      expect(allowed).toBe(true)
      expect(denied).toBe(false)
    })
  })

  describe("denyList", () => {
    it("should deny only specified tools", async () => {
      const canUse = Tool.denyList(["Bash", "KillShell"])

      const allowed1 = await Effect.runPromise(canUse("Read"))
      const allowed2 = await Effect.runPromise(canUse("Write"))
      const denied1 = await Effect.runPromise(canUse("Bash"))
      const denied2 = await Effect.runPromise(canUse("KillShell"))

      expect(allowed1).toBe(true)
      expect(allowed2).toBe(true)
      expect(denied1).toBe(false)
      expect(denied2).toBe(false)
    })

    it("should work with empty list (allow all)", async () => {
      const canUse = Tool.denyList([])

      const result1 = await Effect.runPromise(canUse("Read"))
      const result2 = await Effect.runPromise(canUse("Bash"))

      expect(result1).toBe(true)
      expect(result2).toBe(true)
    })

    it("should work with custom tool names", async () => {
      const canUse = Tool.denyList(["DangerousTool"])

      const allowed = await Effect.runPromise(canUse("Read"))
      const denied = await Effect.runPromise(canUse("DangerousTool"))

      expect(allowed).toBe(true)
      expect(denied).toBe(false)
    })
  })

  describe("CanUseToolCallback", () => {
    it("should be composable with Effect", async () => {
      const canUse: Tool.CanUseToolCallback = (toolName) =>
        Effect.gen(function*() {
          // Simulate async check
          yield* Effect.sync(() => {})
          return toolName.startsWith("Read") || toolName.startsWith("Write")
        })

      const result1 = await Effect.runPromise(canUse("Read"))
      const result2 = await Effect.runPromise(canUse("ReadFile"))
      const result3 = await Effect.runPromise(canUse("Bash"))

      expect(result1).toBe(true)
      expect(result2).toBe(true)
      expect(result3).toBe(false)
    })

    it("should support conditional logic", async () => {
      const isProduction = false
      const canUse: Tool.CanUseToolCallback = (toolName) => Effect.succeed(isProduction ? toolName === "Read" : true)

      const result = await Effect.runPromise(canUse("Bash"))

      expect(result).toBe(true) // Not production, allow all
    })
  })
})
