/**
 * Advanced stream processing example.
 *
 * Demonstrates filtering and transformation of message streams.
 */
import { Console, Effect, Stream } from "effect"
import * as AgentClient from "../src/index.js"

const program = Effect.gen(function*() {
  yield* Console.log("=== Stream Processing Example ===\n")

  const client = yield* AgentClient.ClaudeAgentClient.ClaudeAgentClient

  yield* Console.log("Asking Claude to explain Effect library...\n")

  const stream = client.query({
    prompt: "Explain the Effect library in 3 sentences"
  })

  // Filter and process messages
  const assistantMessages = yield* stream.pipe(
    // Only keep assistant messages
    Stream.filter((message) => message.type === "assistant"),
    // Take first 5 messages
    Stream.take(5),
    // Collect to array
    Stream.runCollect
  )

  yield* Console.log(`Received ${assistantMessages.length} assistant messages:\n`)
  yield* Console.log("---")

  for (const message of assistantMessages) {
    const preview = message.content.slice(0, 100)
    yield* Console.log(`${preview}${message.content.length > 100 ? "..." : ""}`)
  }

  yield* Console.log("---")
  yield* Console.log("Stream processing complete!")
})

Effect.runPromise(
  program.pipe(Effect.provide(AgentClient.ClaudeAgentClient.layer()), Effect.timeout("30 seconds"))
).catch(console.error)
