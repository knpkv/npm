/**
 * Streaming query example.
 *
 * Demonstrates streaming message processing with real-time output.
 *
 * @since 1.0.0
 */
import { Console, Effect, Stream } from "effect"
import * as AgentClient from "../src/index.js"

const program = Effect.gen(function*() {
  yield* Console.log("=== Streaming Example ===\n")

  const client = yield* AgentClient.ClaudeAgentClient.ClaudeAgentClient

  yield* Console.log("Asking Claude to count from 1 to 5...\n")

  // Get stream of messages
  const stream = client.query({
    prompt: "Count from 1 to 5"
  })

  yield* Console.log("Streaming response:\n")

  // Process messages one by one
  yield* stream.pipe(
    Stream.runForEach((message) =>
      Effect.gen(function*() {
        yield* Console.log(`[${message.type}]: ${message.content.slice(0, 100)}`)
      })
    )
  )

  yield* Console.log("\n---")
  yield* Console.log("Streaming complete!")
})

// Run the program with the client layer
Effect.runPromise(
  program.pipe(
    Effect.provide(AgentClient.ClaudeAgentClient.layer()),
    Effect.timeout("30 seconds")
  )
).catch(console.error)
