/**
 * Tool calling example.
 *
 * Demonstrates using the CLI with allowed tools for enhanced capabilities.
 *
 * @since 1.0.0
 */
import { Console, Effect, Layer } from "effect"
import { ClaudeCodeCliClient, layer } from "../src/ClaudeCodeCliClient.js"
import { ClaudeCodeCliConfig } from "../src/ClaudeCodeCliConfig.js"

const program = Effect.gen(function*() {
  // Get the client service
  const client = yield* ClaudeCodeCliClient

  yield* Console.log("Asking Claude to read a file using tools...\n")

  // Execute a query that would benefit from tool usage
  // Note: allowedTools are configured via the config layer (below)
  // The CLI subprocess will be invoked with: --allowedTools Read,Bash,Glob
  const response = yield* client.query(
    "Read the package.json file and tell me the package name"
  )

  yield* Console.log("Response:")
  yield* Console.log(response)
  yield* Console.log("Tool-assisted query complete!")

  return response
})

// Configure client with allowed tools
const config = Layer.succeed(
  ClaudeCodeCliConfig,
  ClaudeCodeCliConfig.of({
    allowedTools: ["Read", "Bash", "Glob"]
  })
)

// Run the program with configuration
Effect.runPromise(
  program.pipe(
    Effect.provide(layer()),
    Effect.provide(config),
    Effect.timeout("15 seconds")
  )
).catch(console.error)
