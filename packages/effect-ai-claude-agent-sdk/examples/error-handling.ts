/**
 * Error handling example.
 *
 * Demonstrates proper error handling with typed errors.
 *
 * @since 1.0.0
 */
import { Console, Effect, Match } from "effect"
import type * as AgentError from "../src/ClaudeAgentError.js"
import * as AgentClient from "../src/index.js"

const program = Effect.gen(function*() {
  yield* Console.log("=== Error Handling Example ===\n")

  const client = yield* AgentClient.ClaudeAgentClient.ClaudeAgentClient

  yield* Console.log("Testing with empty prompt (will fail validation)...\n")

  const response = yield* client.queryText({
    prompt: "" // Invalid - will trigger ValidationError
  })

  yield* Console.log("Response:")
  yield* Console.log("---")
  yield* Console.log(response)
  yield* Console.log("---")
  yield* Console.log("Query completed successfully!")

  return response
})

// Handle errors with pattern matching
const handleError = Match.type<AgentError.AgentError>().pipe(
  Match.tag("ValidationError", (error) =>
    Effect.gen(function*() {
      yield* Console.error("Error: Validation failed")
      yield* Console.error(`  Field: ${error.field}`)
      yield* Console.error(`  Message: ${error.message}`)
      yield* Console.log("\n---")
      yield* Console.log("Recovered with fallback response")
      return "Validation error - prompt was empty"
    })),
  Match.tag("SdkError", (error) =>
    Effect.gen(function*() {
      yield* Console.error("Error: SDK error occurred")
      yield* Console.error(`  Message: ${error.message}`)
      yield* Console.log("\n---")
      yield* Console.log("Recovered with fallback response")
      return "SDK error occurred"
    })),
  Match.tag("StreamError", (error) =>
    Effect.gen(function*() {
      yield* Console.error("Error: Stream processing failed")
      yield* Console.error(`  Message: ${error.message}`)
      if (error.messageId) {
        yield* Console.error(`  Message ID: ${error.messageId}`)
      }
      yield* Console.log("\n---")
      yield* Console.log("Recovered with fallback response")
      return "Stream error occurred"
    })),
  Match.orElse((error) =>
    Effect.gen(function*() {
      yield* Console.error("Error: Unknown error occurred")
      yield* Console.error(`  Message: ${error.message}`)
      yield* Console.log("\n---")
      yield* Console.log("Recovered with fallback response")
      return "Unknown error occurred"
    })
  )
)

// Run the program with error handling
Effect.runPromise(
  program.pipe(
    Effect.catchAll(handleError),
    Effect.provide(AgentClient.ClaudeAgentClient.layer()),
    Effect.timeout("30 seconds")
  )
).catch(console.error)
