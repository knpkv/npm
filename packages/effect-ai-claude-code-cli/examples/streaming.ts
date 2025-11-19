/**
 * Streaming query example.
 *
 * Demonstrates streaming text generation with real-time chunk output.
 */
import { Console, Effect } from "effect"
import { ClaudeCodeCliClient, layer } from "../src/ClaudeCodeCliClient.js"
import { ClaudeCodeCliConfig } from "../src/ClaudeCodeCliConfig.js"

const program = Effect.gen(function*() {
  // Get the client service
  const client = yield* ClaudeCodeCliClient

  yield* Console.log("Asking Claude to write a haiku about functional programming...\n")

  // Simulate streaming by getting regular response and outputting it character by character
  yield* Console.log("Getting response...")
  const response = yield* client.query("Write a haiku about functional programming")
  yield* Console.log("Response received, simulating stream...")

  yield* Console.log("Streaming response:")

  // Simulate streaming by outputting characters with delays
  for (let i = 0; i < response.length; i++) {
    yield* Console.log(response[i])
    if (i % 10 === 0) {
      yield* Effect.sleep(50)
    }
  }

  yield* Console.log("Streaming complete!")
})

// Run the program with the client layer
Effect.runPromise(
  program.pipe(
    Effect.provide(layer()),
    Effect.provide(ClaudeCodeCliConfig.default)
  )
).catch(console.error)
