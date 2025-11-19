/**
 * Configuration example.
 *
 * Demonstrates custom configuration with layers.
 *
 * @since 1.0.0
 */
import { Console, Effect } from "effect"
import * as AgentConfig from "../src/ClaudeAgentConfig.js"
import * as AgentClient from "../src/index.js"

const program = Effect.gen(function*() {
  yield* Console.log("=== Configuration Example ===\n")

  // Access configuration
  const config = yield* AgentConfig.ClaudeAgentConfig
  yield* Console.log("Configuration:")
  yield* Console.log(`  API Key Source: ${config.apiKeySource || "default"}`)
  yield* Console.log(`  Working Directory: ${config.workingDirectory || "default"}`)
  yield* Console.log("")

  // Use client
  const client = yield* AgentClient.ClaudeAgentClient.ClaudeAgentClient

  const result = yield* client.queryText({
    prompt: "What is 2+2?"
  })

  yield* Console.log("Response:")
  yield* Console.log("---")
  yield* Console.log(result)
  yield* Console.log("---")
})

// Create custom config layer
const customConfigLayer = AgentConfig.layer({
  apiKeySource: "project",
  workingDirectory: process.cwd()
})

Effect.runPromise(
  program.pipe(
    Effect.provide(AgentClient.ClaudeAgentClient.layerConfig()),
    Effect.provide(customConfigLayer),
    Effect.timeout("30 seconds")
  )
).catch(console.error)
