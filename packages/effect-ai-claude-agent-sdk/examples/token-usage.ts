/**
 * Token Usage Tracking Example
 *
 * Demonstrates how to track token usage from Claude API responses.
 * Includes per-message and aggregate session statistics.
 */

import { Effect, Stream } from "effect"
import * as AgentClient from "../src/ClaudeAgentClient.js"

const program = Effect.gen(function*() {
  const client = yield* AgentClient.ClaudeAgentClient

  console.log("Querying Claude and tracking token usage...")
  console.log()

  const stream = client.query({
    prompt: "Explain TypeScript in three sentences",
    allowedTools: []
  })

  yield* Stream.runForEach(stream, (message) =>
    Effect.sync(() => {
      if (message.type === "assistant" && message.usage) {
        console.log("Assistant Response:")
        console.log(message.content)
        console.log()
        console.log("Token Usage:")
        console.log(`  Input tokens: ${message.usage.input_tokens}`)
        console.log(`  Output tokens: ${message.usage.output_tokens}`)
        if (message.usage.cache_read_input_tokens) {
          console.log(`  Cache read tokens: ${message.usage.cache_read_input_tokens}`)
        }
        if (message.usage.cache_creation_input_tokens) {
          console.log(`  Cache creation tokens: ${message.usage.cache_creation_input_tokens}`)
        }
        console.log()
      }

      if (message.type === "result" && message.summary) {
        console.log("Session Summary:")
        console.log(`  Total turns: ${message.summary.num_turns}`)
        console.log(`  Duration: ${message.summary.duration_ms}ms`)
        console.log(`  API time: ${message.summary.duration_api_ms}ms`)
        console.log(`  Total cost: $${message.summary.total_cost_usd?.toFixed(6) || "N/A"}`)
        console.log()

        if (message.usage) {
          console.log("Aggregate Token Usage:")
          console.log(`  Total input tokens: ${message.usage.input_tokens}`)
          console.log(`  Total output tokens: ${message.usage.output_tokens}`)
          if (message.usage.cache_read_input_tokens) {
            console.log(`  Total cache read: ${message.usage.cache_read_input_tokens}`)
          }
          if (message.usage.cache_creation_input_tokens) {
            console.log(`  Total cache creation: ${message.usage.cache_creation_input_tokens}`)
          }
        }
      }
    }))
})

Effect.runPromise(program.pipe(Effect.provide(AgentClient.layer())))
