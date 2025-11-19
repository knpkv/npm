/**
 * Retry and resilience example.
 *
 * Demonstrates error recovery with retry logic and timeouts.
 */
import { Console, Effect, Schedule } from "effect"
import * as AgentClient from "../src/index.js"

const program = Effect.gen(function*() {
  yield* Console.log("=== Retry and Resilience Example ===\n")

  const client = yield* AgentClient.ClaudeAgentClient.ClaudeAgentClient

  yield* Console.log("Executing query with retry logic...\n")

  // Query with automatic retry on failures
  const result = yield* client
    .queryText({
      prompt: "What is the capital of France?"
    })
    .pipe(
      // Retry up to 3 times with exponential backoff
      Effect.retry({
        times: 3,
        schedule: Schedule.exponential("100 millis")
      }),
      // Provide fallback if all retries fail
      Effect.catchAll(() => Effect.succeed("Unable to get response after retries")),
      // Add timeout
      Effect.timeout("30 seconds")
    )

  yield* Console.log("Response:")
  yield* Console.log("---")
  yield* Console.log(result)
  yield* Console.log("---")
  yield* Console.log("Query completed successfully!")
})

Effect.runPromise(program.pipe(Effect.provide(AgentClient.ClaudeAgentClient.layer()))).catch(console.error)
