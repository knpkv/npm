/**
 * Chunk logging example with tool calls.
 *
 * Demonstrates logging every response chunk during streaming,
 * including tool call events.
 *
 * @since 1.0.0
 */
import { Console, Effect, Layer, Stream } from "effect"
import { ClaudeCodeCliClient, layer } from "../src/ClaudeCodeCliClient.js"
import { ClaudeCodeCliConfig } from "../src/ClaudeCodeCliConfig.js"

const program = Effect.gen(function*() {
  const client = yield* ClaudeCodeCliClient

  yield* Console.log("Chunk Logging Example with Tool Calls\n")
  yield* Console.log("Streaming response with detailed chunk logging...\n")

  // Get streaming response with a prompt that triggers tool usage
  const stream = client.queryStream("Read the package.json file and tell me the package name and version")

  // Process each chunk and log details
  yield* stream.pipe(
    Stream.runForEach((chunk) =>
      Effect.gen(function*() {
        yield* Console.log(chunk)
      })
    )
  )
})

// Configure with allowed tools to enable tool calls
const config = Layer.succeed(
  ClaudeCodeCliConfig,
  ClaudeCodeCliConfig.of({
    allowedTools: ["Read", "Glob", "Bash"]
  })
)

// Run the program
Effect.runPromise(
  program.pipe(
    Effect.provide(layer()),
    Effect.provide(config),
    Effect.timeout("60 seconds")
  )
).catch(console.error)
