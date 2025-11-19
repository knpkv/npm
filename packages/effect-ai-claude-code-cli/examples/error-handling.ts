/**
 * Error handling example.
 *
 * Demonstrates proper error handling with typed errors.
 */
import { Console, Effect, Match } from "effect"
import { ClaudeCodeCliClient, layer } from "../src/ClaudeCodeCliClient.js"
import { ClaudeCodeCliConfig } from "../src/ClaudeCodeCliConfig.js"
import type { ClaudeCodeCliError } from "../src/ClaudeCodeCliError.js"

const program = Effect.gen(function*() {
  // Get client service
  const client = yield* ClaudeCodeCliClient

  yield* Console.log("Asking Claude: What is Effect-TS?\n")

  const response = yield* client.query("What is Effect-TS?")

  yield* Console.log("Response:")
  yield* Console.log("---")
  yield* Console.log(response)
  yield* Console.log("---")
  yield* Console.log("Query completed successfully!")

  return response
})

// Handle errors with pattern matching
const handleError = Match.type<ClaudeCodeCliError>().pipe(
  Match.tag("CliNotFoundError", () =>
    Effect.gen(function*() {
      yield* Console.error("Error: Claude CLI not found. Please install it:")
      yield* Console.error("  npm install -g @anthropics/claude-code")
      process.exit(1)
    })),
  Match.tag("RateLimitError", (error) =>
    Effect.gen(function*() {
      yield* Console.error("Error: Rate limit exceeded")
      if (error.retryAfter) {
        yield* Console.error(`  Retry after ${error.retryAfter} seconds`)
      }
      yield* Console.error(`  Details: ${error.stderr}`)
      process.exit(1)
    })),
  Match.tag("InvalidApiKeyError", (error) =>
    Effect.gen(function*() {
      yield* Console.error("Error: Invalid API key")
      yield* Console.error(`  Details: ${error.stderr}`)
      yield* Console.error("  Please check your Anthropic API key configuration")
      process.exit(1)
    })),
  Match.tag("StreamParsingError", (error) =>
    Effect.gen(function*() {
      yield* Console.error("Error: Failed to parse stream")
      yield* Console.error(`  Line: ${error.line}`)
      process.exit(1)
    })),
  Match.orElse((error) =>
    Effect.gen(function*() {
      yield* Console.error("Error: Unknown error occurred")
      yield* Console.error(`  Message: ${error.message}`)
      process.exit(1)
    })
  )
)

// Run the program with error handling
Effect.runPromise(
  program.pipe(
    Effect.catchAll(handleError),
    Effect.provide(layer()),
    Effect.provide(ClaudeCodeCliConfig.default),
    Effect.timeout("10 seconds")
  )
).catch(console.error)
