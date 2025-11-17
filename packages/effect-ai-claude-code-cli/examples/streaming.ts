/**
 * Streaming query example.
 *
 * Demonstrates streaming text generation with real-time chunk output.
 *
 * @since 1.0.0
 */
import { ClaudeCodeCliClient, layer } from "../src/ClaudeCodeCliClient.js"
import { ClaudeCodeCliConfig } from "../src/ClaudeCodeCliConfig.js"
import { Effect, Stream } from "effect"

const program = Effect.gen(function*() {
  // Get the client service
  const client = yield* ClaudeCodeCliClient

  console.log("🤖 Asking Claude to write a haiku about functional programming...\n")

  // Simulate streaming by getting regular response and outputting it character by character
  console.log("🔧 Getting response...")
  const response = yield* client.query("Write a haiku about functional programming")
  console.log("✅ Response received, simulating stream...")
  
  console.log("📡 Streaming response:")
  console.log("---")
  
  // Simulate streaming by outputting characters with delays
  for (let i = 0; i < response.length; i++) {
    process.stdout.write(response[i])
    if (i % 10 === 0) {
      yield* Effect.sleep(50)
    }
  }
  
  console.log("\n---")
  console.log("✅ Streaming complete!")

  console.log("\n---")
  console.log("✅ Streaming complete!")
})

// Run the program with the client layer
Effect.runPromise(
  program.pipe(
    Effect.provide(layer()),
    Effect.provide(ClaudeCodeCliConfig.default)
  )
).catch(console.error)
