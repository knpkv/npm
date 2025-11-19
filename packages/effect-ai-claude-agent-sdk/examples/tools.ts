/**
 * Tool calling example.
 *
 * Demonstrates using the SDK with allowed tools for enhanced capabilities.
 *
 * @since 1.0.0
 */
import { Console, Effect } from "effect"
import * as AgentConfig from "../src/ClaudeAgentConfig.js"
import * as AgentClient from "../src/index.js"

const program = Effect.gen(function*() {
  // Get the client service
  const client = yield* AgentClient.ClaudeAgentClient.ClaudeAgentClient

  yield* Console.log("Asking Claude to read a file using tools...\n")

  // Execute a query that would benefit from tool usage
  // You can specify allowedTools either in the config layer (below)
  // or directly in the query options (shown here)
  const response = yield* client.queryText({
    prompt: "Read the package.json file and tell me the package name",
    allowedTools: ["Read", "Bash", "Glob"]
  })

  yield* Console.log("Response:")
  yield* Console.log(response)
  yield* Console.log("Tool-assisted query complete!")

  return response
})

// Configure client with allowed tools
const config = AgentConfig.layer({
  allowedTools: ["Read", "Bash", "Glob"]
})

// Run the program with configuration
Effect.runPromise(
  program.pipe(
    Effect.provide(AgentClient.ClaudeAgentClient.layerConfig()),
    Effect.provide(config),
    Effect.timeout("15 seconds")
  )
).catch(console.error)
