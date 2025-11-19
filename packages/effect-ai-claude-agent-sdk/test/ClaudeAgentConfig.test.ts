/**
 * Unit tests for ClaudeAgentConfig.
 *
 * @since 1.0.0
 */
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentConfig from "../src/ClaudeAgentConfig.js"

describe("ClaudeAgentConfig", () => {
  describe("make", () => {
    it("should create config with default values", () => {
      const config = AgentConfig.make({})

      expect(config.apiKeySource).toBeUndefined()
      expect(config.workingDirectory).toBeUndefined()
      expect(config.allowedTools).toBeUndefined()
      expect(config.disallowedTools).toBeUndefined()
      expect(config.dangerouslySkipPermissions).toBeUndefined()
    })

    it("should create config with apiKeySource", () => {
      const config = AgentConfig.make({ apiKeySource: "project" })

      expect(config.apiKeySource).toBe("project")
    })

    it("should create config with workingDirectory", () => {
      const config = AgentConfig.make({ workingDirectory: "/test/path" })

      expect(config.workingDirectory).toBe("/test/path")
    })

    it("should create config with allowedTools", () => {
      const config = AgentConfig.make({ allowedTools: ["Read", "Write"] })

      expect(config.allowedTools).toEqual(["Read", "Write"])
    })

    it("should create config with disallowedTools", () => {
      const config = AgentConfig.make({ disallowedTools: ["Bash", "Edit"] })

      expect(config.disallowedTools).toEqual(["Bash", "Edit"])
    })

    it("should create config with dangerouslySkipPermissions", () => {
      const config = AgentConfig.make({ dangerouslySkipPermissions: true })

      expect(config.dangerouslySkipPermissions).toBe(true)
    })

    it("should create config with empty allowedTools array", () => {
      const config = AgentConfig.make({ allowedTools: [] })

      expect(config.allowedTools).toEqual([])
    })

    it("should create config with all options", () => {
      const config = AgentConfig.make({
        apiKeySource: "user",
        workingDirectory: "/custom/dir",
        allowedTools: ["Read"],
        disallowedTools: ["Write"],
        dangerouslySkipPermissions: false
      })

      expect(config.apiKeySource).toBe("user")
      expect(config.workingDirectory).toBe("/custom/dir")
      expect(config.allowedTools).toEqual(["Read"])
      expect(config.disallowedTools).toEqual(["Write"])
      expect(config.dangerouslySkipPermissions).toBe(false)
    })
  })

  describe("layer", () => {
    it("should create layer with default config", async () => {
      const program = Effect.gen(function*() {
        const config = yield* AgentConfig.ClaudeAgentConfig
        return config
      })

      const result = await Effect.runPromise(
        program.pipe(Effect.provide(AgentConfig.layer({})))
      )

      expect(result.apiKeySource).toBeUndefined()
      expect(result.workingDirectory).toBeUndefined()
    })

    it("should create layer with custom config", async () => {
      const program = Effect.gen(function*() {
        const config = yield* AgentConfig.ClaudeAgentConfig
        return config
      })

      const result = await Effect.runPromise(
        program.pipe(
          Effect.provide(
            AgentConfig.layer({
              apiKeySource: "project",
              allowedTools: ["Read", "Write"]
            })
          )
        )
      )

      expect(result.apiKeySource).toBe("project")
      expect(result.allowedTools).toEqual(["Read", "Write"])
    })

    it("should create layer with empty allowedTools", async () => {
      const program = Effect.gen(function*() {
        const config = yield* AgentConfig.ClaudeAgentConfig
        return config
      })

      const result = await Effect.runPromise(
        program.pipe(Effect.provide(AgentConfig.layer({ allowedTools: [] })))
      )

      expect(result.allowedTools).toEqual([])
    })
  })
})
