/**
 * Basic example.
 *
 * Demonstrates basic usage of the ClaudeCodeCliClient.
 */
import { ClaudeCodeCliClient, ClaudeCodeCliConfig } from "@knpkv/effect-ai-claude-code-cli"
import { Console, Effect } from "effect"

const program = Effect.gen(function*() {
  yield* Console.log("=== Basic Example ===\n")

  const client = yield* ClaudeCodeCliClient.ClaudeCodeCliClient
  const response = yield* client.query("Hello, world!")

  yield* Console.log("Response:")
  yield* Console.log("---")
  yield* Console.log(response)
  yield* Console.log("---")
})

// Provide layers
Effect.runPromise(
  program.pipe(
    Effect.provide(ClaudeCodeCliClient.layer()),
    Effect.provide(ClaudeCodeCliConfig.ClaudeCodeCliConfig.default)
  )
).catch(console.error)
