/**
 * Error handling example.
 *
 * Demonstrates proper error handling with typed errors.
 *
 * @since 1.0.0
 */
import type { ClaudeCodeCliError } from "../src/ClaudeCodeCliError.js"
import { ClaudeCodeCliClient } from "../src/ClaudeCodeCliClient.js"
import { layer } from "../src/ClaudeCodeCliClient.js"
import { ClaudeCodeCliConfig } from "../src/ClaudeCodeCliConfig.js"
import { Effect, Match } from "effect"

const program = Effect.gen(function*() {
  // Get client service
  const client = yield* ClaudeCodeCliClient

  console.log("🤖 Asking Claude: What is Effect-TS?\n")

  const response = yield* client.query("What is Effect-TS?")

  console.log("📝 Response:")
  console.log("---")
  console.log(response)
  console.log("---")
  console.log("✅ Query completed successfully!")

  return response
})

// Handle errors with pattern matching
const handleError = Match.type<ClaudeCodeCliError>().pipe(
  Match.tag("CliNotFoundError", () =>
    Effect.sync(() => {
      console.error("Error: Claude CLI not found. Please install it:")
      console.error("  npm install -g @anthropics/claude-code")
      process.exit(1)
    })),
  Match.tag("RateLimitError", (error) =>
    Effect.sync(() => {
      console.error("Error: Rate limit exceeded")
      if (error.retryAfter) {
        console.error(`  Retry after ${error.retryAfter} seconds`)
      }
      console.error(`  Details: ${error.stderr}`)
      process.exit(1)
    })),
  Match.tag("InvalidApiKeyError", (error) =>
    Effect.sync(() => {
      console.error("Error: Invalid API key")
      console.error(`  Details: ${error.stderr}`)
      console.error("  Please check your Anthropic API key configuration")
      process.exit(1)
    })),
  Match.tag("StreamParsingError", (error) =>
    Effect.sync(() => {
      console.error("Error: Failed to parse stream")
      console.error(`  Line: ${error.line}`)
      process.exit(1)
    })),
  Match.orElse((error) =>
    Effect.sync(() => {
      console.error("Error: Unknown error occurred")
      console.error(`  Message: ${error.message}`)
      process.exit(1)
    })
  )
)

// Run the program with error handling
Effect.runPromise(
  program.pipe(
    Effect.provide(layer()),
    Effect.provide(ClaudeCodeCliConfig.default),
    Effect.timeout("10 seconds")
  )
).catch(console.error)
