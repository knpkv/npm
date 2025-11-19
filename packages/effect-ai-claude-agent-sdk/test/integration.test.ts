/**
 * Integration tests for Claude Agent SDK.
 *
 * Tests real API calls to verify compatibility with @anthropic-ai/claude-agent-sdk.
 * Requires ANTHROPIC_API_KEY environment variable.
 */
import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentClient from "../src/ClaudeAgentClient.js"
import * as AgentConfig from "../src/ClaudeAgentConfig.js"

const INTEGRATION_TIMEOUT = 60_000

describe("Integration: Claude Agent SDK", () => {
  it(
    "should execute basic query without tools",
    async () => {
      const program = Effect.gen(function*() {
        const client = yield* AgentClient.ClaudeAgentClient

        const result = yield* client.queryText({
          prompt: "What is 2+2? Answer with just the number.",
          allowedTools: [] // No tools needed for math
        })

        return result
      })

      const result = await Effect.runPromise(program.pipe(Effect.provide(AgentClient.layer())))

      expect(result).toContain("4")
    },
    INTEGRATION_TIMEOUT
  )

  it(
    "should respect tool restrictions (allowedTools: [])",
    async () => {
      const program = Effect.gen(function*() {
        const client = yield* AgentClient.ClaudeAgentClient

        let toolsUsed = 0
        const stream = client.query({
          prompt: "Read the package.json file",
          allowedTools: [] // Deny all tools
        })

        yield* stream.pipe(
          Stream.runForEach((message) =>
            Effect.sync(() => {
              if (message.type === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
                toolsUsed += message.toolCalls.length
              }
            })
          )
        )

        return toolsUsed
      })

      const toolsUsed = await Effect.runPromise(program.pipe(Effect.provide(AgentClient.layer())))

      expect(toolsUsed).toBe(0)
    },
    INTEGRATION_TIMEOUT
  )

  it(
    "should work with layerConfig",
    async () => {
      const config = AgentConfig.layer({
        allowedTools: []
      })

      const program = Effect.gen(function*() {
        const client = yield* AgentClient.ClaudeAgentClient

        const result = yield* client.queryText({
          prompt: "What is Effect-TS? Answer in one sentence."
        })

        return result
      })

      const result = await Effect.runPromise(
        program.pipe(Effect.provide(AgentClient.layerConfig()), Effect.provide(config))
      )

      expect(result).toBeTruthy()
      expect(result.length).toBeGreaterThan(10)
    },
    INTEGRATION_TIMEOUT
  )

  it(
    "should stream responses correctly",
    async () => {
      const program = Effect.gen(function*() {
        const client = yield* AgentClient.ClaudeAgentClient

        let messageCount = 0
        let hasText = false

        const stream = client.query({
          prompt: "Say hello",
          allowedTools: []
        })

        yield* stream.pipe(
          Stream.runForEach((message) =>
            Effect.sync(() => {
              messageCount++
              if (message.type === "assistant" && message.content.length > 0) {
                hasText = true
              }
            })
          )
        )

        return { messageCount, hasText }
      })

      const result = await Effect.runPromise(program.pipe(Effect.provide(AgentClient.layer())))

      expect(result.messageCount).toBeGreaterThan(1)
      expect(result.hasText).toBe(true)
    },
    INTEGRATION_TIMEOUT
  )
})
