/**
 * Unit tests for Brand module.
 */
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentBrand from "../src/Brand.js"

describe("Brand", () => {
  describe("ApiKeySource", () => {
    it("should accept valid API key sources", () => {
      const validSources: Array<AgentBrand.ApiKeySource> = ["user", "project", "org", "temporary"]

      for (const source of validSources) {
        expect(source).toBeDefined()
      }
    })
  })

  describe("ToolName", () => {
    it("should create branded tool name", () => {
      const toolName = AgentBrand.ToolName("Read")

      expect(toolName).toBe("Read")
      // TypeScript ensures it's branded at compile time
    })

    it("should create different tool names", () => {
      const read = AgentBrand.ToolName("Read")
      const write = AgentBrand.ToolName("Write")
      const bash = AgentBrand.ToolName("Bash")

      expect(read).toBe("Read")
      expect(write).toBe("Write")
      expect(bash).toBe("Bash")
    })

    it("should work with custom tool names", () => {
      const customTool = AgentBrand.ToolName("CustomTool")

      expect(customTool).toBe("CustomTool")
    })
  })

  describe("HookName", () => {
    it("should create branded hook name", () => {
      const hookName = AgentBrand.HookName("SessionStart")

      expect(hookName).toBe("SessionStart")
    })

    it("should create different hook names", () => {
      const sessionStart = AgentBrand.HookName("SessionStart")
      const preToolUse = AgentBrand.HookName("PreToolUse")
      const postToolUse = AgentBrand.HookName("PostToolUse")

      expect(sessionStart).toBe("SessionStart")
      expect(preToolUse).toBe("PreToolUse")
      expect(postToolUse).toBe("PostToolUse")
    })
  })

  describe("WorkingDirectory", () => {
    it("should create valid working directory", () => {
      const dir = AgentBrand.WorkingDirectory("/home/user/project")

      expect(dir).toBe("/home/user/project")
    })

    it("should create working directory with relative path", () => {
      const dir = AgentBrand.WorkingDirectory("./relative/path")

      expect(dir).toBe("./relative/path")
    })

    it("should reject empty working directory", () => {
      expect(() => AgentBrand.WorkingDirectory("")).toThrow()
    })

    it("should work with absolute paths", () => {
      const unixPath = AgentBrand.WorkingDirectory("/usr/local/bin")
      const windowsPath = AgentBrand.WorkingDirectory("C:\\Users\\test")

      expect(unixPath).toBe("/usr/local/bin")
      expect(windowsPath).toBe("C:\\Users\\test")
    })

    it("should integrate with Effect using try/catch", async () => {
      const program = Effect.try(() => AgentBrand.WorkingDirectory("/test/path"))

      const result = await Effect.runPromise(program)

      expect(result).toBe("/test/path")
    })

    it("should handle validation errors in Effect using try", async () => {
      const program = Effect.try(() => AgentBrand.WorkingDirectory(""))

      const exit = await Effect.runPromiseExit(program)

      expect(exit._tag).toBe("Failure")
    })
  })

  describe("MessageId", () => {
    it("should create branded message ID", () => {
      const messageId = AgentBrand.MessageId("msg_123")

      expect(messageId).toBe("msg_123")
    })

    it("should create different message IDs", () => {
      const id1 = AgentBrand.MessageId("msg_001")
      const id2 = AgentBrand.MessageId("msg_002")
      const id3 = AgentBrand.MessageId("custom_id_xyz")

      expect(id1).toBe("msg_001")
      expect(id2).toBe("msg_002")
      expect(id3).toBe("custom_id_xyz")
    })

    it("should work with UUIDs", () => {
      const uuid = AgentBrand.MessageId("550e8400-e29b-41d4-a716-446655440000")

      expect(uuid).toBe("550e8400-e29b-41d4-a716-446655440000")
    })
  })

  describe("Type safety", () => {
    it("should enforce type distinctions at compile time", () => {
      const toolName = AgentBrand.ToolName("Read")
      const hookName = AgentBrand.HookName("SessionStart")
      const messageId = AgentBrand.MessageId("msg_123")

      // These are all strings at runtime
      expect(typeof toolName).toBe("string")
      expect(typeof hookName).toBe("string")
      expect(typeof messageId).toBe("string")

      // But TypeScript knows they're different branded types
      // This is verified at compile time by the type system
    })

    it("should work in arrays", () => {
      const tools = [AgentBrand.ToolName("Read"), AgentBrand.ToolName("Write"), AgentBrand.ToolName("Edit")]

      expect(tools).toHaveLength(3)
      expect(tools[0]).toBe("Read")
    })

    it("should work in objects", () => {
      const config = {
        tool: AgentBrand.ToolName("Bash"),
        hook: AgentBrand.HookName("PreToolUse"),
        messageId: AgentBrand.MessageId("msg_001")
      }

      expect(config.tool).toBe("Bash")
      expect(config.hook).toBe("PreToolUse")
      expect(config.messageId).toBe("msg_001")
    })
  })
})
