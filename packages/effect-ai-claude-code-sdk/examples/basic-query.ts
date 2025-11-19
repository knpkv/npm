/**
 * Basic example.
 *
 * Demonstrates basic usage of the ClaudeAgentClient.
 *
 * @since 1.0.0
 */
import { Console, Effect } from "effect"
import * as AgentClient from "../src/index.js"

const program = Effect.gen(function*() {
  yield* Console.log("=== Basic Example ===\n")

  const client = yield* AgentClient.ClaudeAgentClient.ClaudeAgentClient
  const response = yield* client.queryText({
    prompt: "What is Effect-TS in one sentence?"
  })

  yield* Console.log("Response:")
  yield* Console.log("---")
  yield* Console.log(response)
  yield* Console.log("---")
})

// Provide layers
Effect.runPromise(
  program.pipe(
    Effect.provide(AgentClient.ClaudeAgentClient.layer()),
    Effect.timeout("30 seconds")
  )
).catch(console.error)
