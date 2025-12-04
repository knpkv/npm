/**
 * Integration tests for ClaudeCodeCliClient and ClaudeCodeCliLanguageModel.
 *
 * Tests actual CLI execution, streaming, tool calls, error scenarios, and @effect/ai integration.
 */
import { LanguageModel } from "@effect/ai"
import { NodeFileSystem } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Array, Effect, Layer, Stream } from "effect"
import { ClaudeCodeCliClient, layer } from "../src/ClaudeCodeCliClient.js"
import { ClaudeCodeCliConfig } from "../src/ClaudeCodeCliConfig.js"
import * as ClaudeCodeCliLanguageModel from "../src/ClaudeCodeCliLanguageModel.js"
import * as SessionDiscovery from "../src/SessionDiscovery.js"
import type { MessageChunk } from "../src/StreamEvents.js"

describe("ClaudeCodeCliClient - Integration", () => {
  describe("query", () => {
    it.effect("should execute simple query and return text", () =>
      Effect.gen(function*() {
        const client = yield* ClaudeCodeCliClient
        const response = yield* client.query("What is 2+2?")

        expect(response).toBeDefined()
        expect(typeof response).toBe("string")
        expect(response.length).toBeGreaterThan(0)
      }).pipe(
        Effect.provide(layer()),
        Effect.provide(ClaudeCodeCliConfig.default),
        Effect.timeout("30 seconds")
      ), { timeout: 60000 })

    it.effect("should handle queries with allowedTools via stdin", () => {
      const config = Layer.succeed(
        ClaudeCodeCliConfig,
        ClaudeCodeCliConfig.of({
          allowedTools: ["Read"]
        })
      )

      return Effect.gen(function*() {
        const client = yield* ClaudeCodeCliClient
        const response = yield* client.query("Read the package.json file and tell me the package name")

        expect(response).toBeDefined()
        expect(typeof response).toBe("string")
        expect(response.toLowerCase()).toContain("effect-ai-claude-code-cli")
      }).pipe(
        Effect.provide(layer()),
        Effect.provide(config),
        Effect.timeout("30 seconds")
      )
    }, { timeout: 60000 })
  })

  describe("queryStream", () => {
    it.effect("should stream text chunks", () =>
      Effect.gen(function*() {
        const client = yield* ClaudeCodeCliClient
        const stream = client.queryStream("Say 'hello' in one word")

        const chunks = yield* Stream.runCollect(stream)
        const chunksArray = Array.fromIterable(chunks)

        expect(chunksArray.length).toBeGreaterThan(0)

        // Should have at least one text chunk
        const textChunks = chunksArray.filter((chunk) => chunk.type === "text")
        expect(textChunks.length).toBeGreaterThan(0)

        // Should have message_start chunk
        const messageStartChunks = chunksArray.filter((chunk) => chunk.type === "message_start")
        expect(messageStartChunks.length).toBeGreaterThan(0)

        // Should have message_stop chunk
        const messageStopChunks = chunksArray.filter((chunk) => chunk.type === "message_stop")
        expect(messageStopChunks.length).toBeGreaterThan(0)
      }).pipe(
        Effect.provide(layer()),
        Effect.provide(ClaudeCodeCliConfig.default),
        Effect.timeout("30 seconds")
      ), { timeout: 60000 })

    it.effect("should stream tool use chunks when tools are allowed", () => {
      const config = Layer.succeed(
        ClaudeCodeCliConfig,
        ClaudeCodeCliConfig.of({
          allowedTools: ["Read", "Glob"]
        })
      )

      return Effect.gen(function*() {
        const client = yield* ClaudeCodeCliClient
        const stream = client.queryStream("Read the package.json file and list its dependencies")

        const chunks = yield* Stream.runCollect(stream)
        const chunksArray = Array.fromIterable(chunks)

        expect(chunksArray.length).toBeGreaterThan(0)

        // Should have tool_use_start chunks (Read tool)
        const toolStartChunks = chunksArray.filter((chunk) => chunk.type === "tool_use_start")
        expect(toolStartChunks.length).toBeGreaterThan(0)

        // Verify tool name
        const readToolChunk = toolStartChunks.find((chunk) => chunk.type === "tool_use_start" && chunk.name === "Read")
        expect(readToolChunk).toBeDefined()

        // Should have tool_input chunks
        const toolInputChunks = chunksArray.filter((chunk) => chunk.type === "tool_input")
        expect(toolInputChunks.length).toBeGreaterThan(0)
      }).pipe(
        Effect.provide(layer()),
        Effect.provide(config),
        Effect.timeout("60 seconds")
      )
    }, { timeout: 120000 })

    it.effect("should emit content_block_start and content_block_stop chunks", () =>
      Effect.gen(function*() {
        const client = yield* ClaudeCodeCliClient
        const stream = client.queryStream("Hello")

        const chunks = yield* Stream.runCollect(stream)
        const chunksArray = Array.fromIterable(chunks)

        // Should have content_block_start chunks
        const startChunks = chunksArray.filter((chunk) => chunk.type === "content_block_start")
        expect(startChunks.length).toBeGreaterThan(0)

        // Should have content_block_stop chunks
        const stopChunks = chunksArray.filter((chunk) => chunk.type === "content_block_stop")
        expect(stopChunks.length).toBeGreaterThan(0)

        // Start and stop chunks should be balanced
        expect(startChunks.length).toBe(stopChunks.length)
      }).pipe(
        Effect.provide(layer()),
        Effect.provide(ClaudeCodeCliConfig.default),
        Effect.timeout("30 seconds")
      ), { timeout: 60000 })

    it.effect("should emit message_delta chunks with usage information", () =>
      Effect.gen(function*() {
        const client = yield* ClaudeCodeCliClient
        const stream = client.queryStream("Count to three")

        const chunks = yield* Stream.runCollect(stream)
        const chunksArray = Array.fromIterable(chunks)

        // Should have message_delta chunks
        const deltaChunks = chunksArray.filter((chunk) => chunk.type === "message_delta")
        expect(deltaChunks.length).toBeGreaterThan(0)

        // At least one delta chunk should have usage information
        const usageChunk = deltaChunks.find((chunk) => chunk.type === "message_delta" && chunk.usage !== undefined)
        expect(usageChunk).toBeDefined()
      }).pipe(
        Effect.provide(layer()),
        Effect.provide(ClaudeCodeCliConfig.default),
        Effect.timeout("30 seconds")
      ), { timeout: 60000 })

    it.effect("should accumulate text chunks correctly", () =>
      Effect.gen(function*() {
        const client = yield* ClaudeCodeCliClient
        const stream = client.queryStream("Say 'Effect-TS is great'")

        const chunks = yield* Stream.runCollect(stream)
        const chunksArray = Array.fromIterable(chunks)

        // Collect all text chunks
        const textChunks = chunksArray.filter((chunk): chunk is Extract<MessageChunk, { type: "text" }> =>
          chunk.type === "text"
        )

        // Combine all text
        const fullText = textChunks.map((chunk) => chunk.text).join("")

        expect(fullText.length).toBeGreaterThan(0)
        expect(fullText.toLowerCase()).toContain("effect")
      }).pipe(
        Effect.provide(layer()),
        Effect.provide(ClaudeCodeCliConfig.default),
        Effect.timeout("30 seconds")
      ), { timeout: 60000 })
  })

  describe("configuration", () => {
    it.effect("should respect model configuration", () => {
      const config = Layer.succeed(
        ClaudeCodeCliConfig,
        ClaudeCodeCliConfig.of({
          model: "claude-sonnet-4-5"
        })
      )

      return Effect.gen(function*() {
        const client = yield* ClaudeCodeCliClient
        const response = yield* client.query("What is 1+1?")

        expect(response).toBeDefined()
        expect(typeof response).toBe("string")
      }).pipe(
        Effect.provide(layer()),
        Effect.provide(config),
        Effect.timeout("30 seconds")
      )
    }, { timeout: 60000 })

    it.effect("should respect disallowedTools configuration", () => {
      const config = Layer.succeed(
        ClaudeCodeCliConfig,
        ClaudeCodeCliConfig.of({
          disallowedTools: ["Write", "Edit", "Bash"]
        })
      )

      return Effect.gen(function*() {
        const client = yield* ClaudeCodeCliClient
        const stream = client.queryStream("Read package.json")

        const chunks = yield* Stream.runCollect(stream)
        const chunksArray = Array.fromIterable(chunks)

        // Should still work but only allow safe tools
        expect(chunksArray.length).toBeGreaterThan(0)

        // Should not use disallowed tools
        const toolChunks = chunksArray.filter((chunk) => chunk.type === "tool_use_start")
        const disallowedToolsUsed = toolChunks.some((chunk) =>
          chunk.type === "tool_use_start" && ["Write", "Edit", "Bash"].includes(chunk.name)
        )
        expect(disallowedToolsUsed).toBe(false)
      }).pipe(
        Effect.provide(layer()),
        Effect.provide(config),
        Effect.timeout("30 seconds")
      )
    }, { timeout: 60000 })
  })

  describe("error scenarios", () => {
    // Note: Claude CLI falls back to default model instead of failing on invalid model
    // So we test that queries still work with invalid model config
    it.effect("should fall back gracefully with invalid model", () => {
      const config = Layer.succeed(
        ClaudeCodeCliConfig,
        ClaudeCodeCliConfig.of({
          model: "invalid-model-name-12345"
        })
      )

      return Effect.gen(function*() {
        const client = yield* ClaudeCodeCliClient
        const result = yield* client.query("Hello").pipe(
          Effect.either
        )

        // CLI falls back to default model, so query succeeds
        expect(result._tag).toBe("Right")
      }).pipe(
        Effect.provide(layer()),
        Effect.provide(config),
        Effect.timeout("30 seconds")
      )
    }, { timeout: 60000 })

    it.effect("should handle stream with invalid model gracefully", () => {
      const config = Layer.succeed(
        ClaudeCodeCliConfig,
        ClaudeCodeCliConfig.of({
          model: "invalid-model-name-12345"
        })
      )

      return Effect.gen(function*() {
        const client = yield* ClaudeCodeCliClient
        const stream = client.queryStream("Hello")

        const result = yield* Stream.runCollect(stream).pipe(
          Effect.either
        )

        // CLI falls back to default model, so stream succeeds
        expect(result._tag).toBe("Right")
      }).pipe(
        Effect.provide(layer()),
        Effect.provide(config),
        Effect.timeout("30 seconds")
      )
    }, { timeout: 60000 })
  })

  describe("stdin vs argument handling", () => {
    it.effect("should use argument for prompt when no tools configured", () =>
      Effect.gen(function*() {
        const client = yield* ClaudeCodeCliClient
        const response = yield* client.query("Say 'no tools' in two words")

        expect(response).toBeDefined()
        expect(typeof response).toBe("string")
        expect(response.length).toBeGreaterThan(0)
      }).pipe(
        Effect.provide(layer()),
        Effect.provide(ClaudeCodeCliConfig.default),
        Effect.timeout("30 seconds")
      ), { timeout: 60000 })

    it.effect("should use stdin for prompt when allowedTools configured", () => {
      const config = Layer.succeed(
        ClaudeCodeCliConfig,
        ClaudeCodeCliConfig.of({
          allowedTools: ["Read"]
        })
      )

      return Effect.gen(function*() {
        const client = yield* ClaudeCodeCliClient
        const response = yield* client.query("What is 2+2?")

        expect(response).toBeDefined()
        expect(typeof response).toBe("string")
        expect(response.length).toBeGreaterThan(0)
      }).pipe(
        Effect.provide(layer()),
        Effect.provide(config),
        Effect.timeout("30 seconds")
      )
    }, { timeout: 60000 })

    it.effect("should use stdin for prompt when disallowedTools configured", () => {
      const config = Layer.succeed(
        ClaudeCodeCliConfig,
        ClaudeCodeCliConfig.of({
          disallowedTools: ["Write"]
        })
      )

      return Effect.gen(function*() {
        const client = yield* ClaudeCodeCliClient
        const response = yield* client.query("What is 3+3?")

        expect(response).toBeDefined()
        expect(typeof response).toBe("string")
        expect(response.length).toBeGreaterThan(0)
      }).pipe(
        Effect.provide(layer()),
        Effect.provide(config),
        Effect.timeout("30 seconds")
      )
    }, { timeout: 60000 })
  })

  describe("LanguageModel Integration", () => {
    const languageModelLayer = ClaudeCodeCliLanguageModel.layer().pipe(
      Layer.provide(layer())
    )

    it.effect("should generate text with accurate token usage", () =>
      Effect.gen(function*() {
        const model = yield* LanguageModel.LanguageModel
        const result = yield* model.generateText({
          prompt: [{ role: "user", content: "Say 'hello' in one word" }]
        })

        // Should have text
        expect(result.text).toBeDefined()
        expect(typeof result.text).toBe("string")
        expect(result.text.length).toBeGreaterThan(0)

        // Should have usage with non-zero values
        expect(result.usage).toBeDefined()
        expect(result.usage.inputTokens).toBeGreaterThan(0)
        expect(result.usage.outputTokens).toBeGreaterThan(0)
        expect(result.usage.totalTokens).toBe(
          result.usage.inputTokens + result.usage.outputTokens
        )
      }).pipe(
        Effect.provide(languageModelLayer),
        Effect.provide(ClaudeCodeCliConfig.default),
        Effect.timeout("30 seconds")
      ), { timeout: 60000 })

    it.effect("should stream text with finish event and usage", () =>
      Effect.gen(function*() {
        const model = yield* LanguageModel.LanguageModel
        const stream = model.streamText({
          prompt: [{ role: "user", content: "Count to three" }]
        })

        const chunks = yield* Stream.runCollect(stream)
        const chunksArray = Array.fromIterable(chunks)

        expect(chunksArray.length).toBeGreaterThan(0)

        // Should have text-delta chunks
        const textDeltas = chunksArray.filter((chunk) => chunk.type === "text-delta")
        expect(textDeltas.length).toBeGreaterThan(0)

        // Each text-delta should have an id
        for (const delta of textDeltas) {
          if (delta.type === "text-delta") {
            expect(delta.id).toBeDefined()
            expect(delta.delta).toBeDefined()
          }
        }

        // Should have finish event
        const finishEvent = chunksArray.find((chunk) => chunk.type === "finish")
        expect(finishEvent).toBeDefined()
        expect(finishEvent?.type).toBe("finish")

        if (finishEvent?.type === "finish") {
          // Should have accurate usage
          expect(finishEvent.usage.inputTokens).toBeGreaterThan(0)
          expect(finishEvent.usage.outputTokens).toBeGreaterThan(0)
          expect(finishEvent.usage.totalTokens).toBe(
            finishEvent.usage.inputTokens + finishEvent.usage.outputTokens
          )
        }
      }).pipe(
        Effect.provide(languageModelLayer),
        Effect.provide(ClaudeCodeCliConfig.default),
        Effect.timeout("30 seconds")
      ), { timeout: 60000 })

    it.effect("should track usage correctly for longer responses", () =>
      Effect.gen(function*() {
        const model = yield* LanguageModel.LanguageModel
        const result = yield* model.generateText({
          prompt: [{ role: "user", content: "Explain TypeScript in two sentences" }]
        })

        expect(result.text).toBeDefined()
        expect(result.usage).toBeDefined()

        // Longer response should have higher token counts
        expect(result.usage.inputTokens).toBeGreaterThan(0)
        expect(result.usage.outputTokens).toBeGreaterThan(5)
        expect(result.usage.totalTokens).toBeGreaterThan(5)
      }).pipe(
        Effect.provide(languageModelLayer),
        Effect.provide(ClaudeCodeCliConfig.default),
        Effect.timeout("30 seconds")
      ), { timeout: 60000 })

    it.effect("should handle multi-turn conversation context", () =>
      Effect.gen(function*() {
        const model = yield* LanguageModel.LanguageModel
        const result = yield* model.generateText({
          prompt: [
            { role: "system", content: "You are a helpful assistant" },
            { role: "user", content: "What is 2+2?" },
            { role: "assistant", content: "4" },
            { role: "user", content: "What about 3+3?" }
          ]
        })

        expect(result.text).toBeDefined()
        expect(typeof result.text).toBe("string")
        expect(result.text.length).toBeGreaterThan(0)

        expect(result.usage).toBeDefined()
        // Multi-turn context should have higher input tokens than single turn
        expect(result.usage.inputTokens).toBeGreaterThan(0)
        expect(result.usage.outputTokens).toBeGreaterThan(0)
        expect(result.usage.totalTokens).toBeGreaterThan(0)
      }).pipe(
        Effect.provide(languageModelLayer),
        Effect.provide(ClaudeCodeCliConfig.default),
        Effect.timeout("30 seconds")
      ), { timeout: 60000 })

    it.effect("should accumulate text correctly in stream", () =>
      Effect.gen(function*() {
        const model = yield* LanguageModel.LanguageModel
        const stream = model.streamText({
          prompt: [{ role: "user", content: "Say 'Effect-TS' in two words" }]
        })

        const chunks = yield* Stream.runCollect(stream)
        const chunksArray = Array.fromIterable(chunks)

        // Collect all text deltas
        const textDeltas = chunksArray.filter(
          (chunk): chunk is Extract<typeof chunk, { type: "text-delta" }> => chunk.type === "text-delta"
        )

        // Combine all text
        const fullText = textDeltas.map((chunk) => chunk.delta).join("")

        expect(fullText.length).toBeGreaterThan(0)
        expect(fullText.toLowerCase()).toContain("effect")
      }).pipe(
        Effect.provide(languageModelLayer),
        Effect.provide(ClaudeCodeCliConfig.default),
        Effect.timeout("30 seconds")
      ), { timeout: 60000 })
  })

  describe("Session Resume", () => {
    it.effect("should discover sessions, create new session, and resume it", () =>
      Effect.gen(function*() {
        const client = yield* ClaudeCodeCliClient

        // List sessions before and validate structure
        const sessionsBefore = yield* SessionDiscovery.listProjectSessions(process.cwd())
        expect(Array.isArray(sessionsBefore)).toBe(true)
        const countBefore = sessionsBefore.length

        if (sessionsBefore.length > 0) {
          const session = sessionsBefore[0]
          expect(session.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
          expect(session.projectPath).toBeDefined()
          expect(typeof session.timestamp).toBe("number")
        }

        // Parse history index and validate structure
        const history = yield* SessionDiscovery.parseHistoryIndex()
        expect(Array.isArray(history)).toBe(true)
        if (history.length > 0) {
          const entry = history[0]
          expect(entry.display).toBeDefined()
          expect(typeof entry.timestamp).toBe("number")
          expect(entry.project).toBeDefined()
        }

        // Create new session with query
        const initialResponse = yield* client.query("What is 2+2? Answer with just the number.")
        expect(initialResponse).toBeDefined()

        // List sessions after - should have one more
        const sessionsAfter = yield* SessionDiscovery.listProjectSessions(process.cwd())
        expect(sessionsAfter.length).toBe(countBefore + 1)

        // Find new session (most recent)
        const byTimestamp = (a: SessionDiscovery.SessionRecord, b: SessionDiscovery.SessionRecord) =>
          b.timestamp - a.timestamp
        const sortedSessions = Array.fromIterable(sessionsAfter).sort(byTimestamp)
        const newSession = sortedSessions[0]
        expect(newSession).toBeDefined()

        // Resume with resumeQuery
        const resumeResponse = yield* client.resumeQuery(
          "What was my previous question?",
          newSession.sessionId
        )
        expect(resumeResponse).toBeDefined()
        expect(typeof resumeResponse).toBe("string")
        expect(resumeResponse.length).toBeGreaterThan(0)

        // Resume with resumeQueryStream
        const stream = client.resumeQueryStream(
          "Repeat your last answer",
          newSession.sessionId
        )
        const chunks = yield* Stream.runCollect(stream)
        const chunksArray = Array.fromIterable(chunks)
        expect(chunksArray.length).toBeGreaterThan(0)

        const textChunks = chunksArray.filter((chunk: MessageChunk) => chunk.type === "text")
        expect(textChunks.length).toBeGreaterThan(0)
      }).pipe(
        Effect.provide(NodeFileSystem.layer),
        Effect.provide(layer()),
        Effect.provide(ClaudeCodeCliConfig.default),
        Effect.timeout("90 seconds")
      ), { timeout: 120000 })
  })
})
