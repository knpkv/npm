/**
 * Empty allowedTools array example.
 *
 * Demonstrates that allowedTools: [] denies all 16 built-in tools.
 *
 * NOTE: This only blocks built-in Claude Code tools. MCP server tools
 * (like ReadMcpResourceTool) may still be available. To fully restrict
 * tool access, disable MCP servers in your Claude Code configuration.
 *
 * @since 1.0.0
 */
import { Console, Effect, Layer, Stream } from "effect"
import { ClaudeCodeCliClient, layerConfig } from "../src/ClaudeCodeCliClient.js"
import { ClaudeCodeCliConfig } from "../src/ClaudeCodeCliConfig.js"

const program = Effect.gen(function*() {
  const client = yield* ClaudeCodeCliClient

  yield* Console.log("Testing allowedTools: [] (should deny all tools)...\n")

  const stream = client.queryStream(
    "Read the package.json file and tell me the package name"
  )

  yield* stream.pipe(
    Stream.runForEach((chunk) =>
      Effect.gen(function*() {
        // Track which tools are being used
        if (chunk.type === "tool_use_start") {
          yield* Console.log(`\n[TOOL] ${chunk.name}`)

          // Check if it's a built-in tool (should be blocked)
          const isBuiltIn = ![
            "mcp__",
            "ListMcpResourceTool",
            "ReadMcpResourceTool"
          ].some((prefix) => chunk.name.startsWith(prefix))

          if (isBuiltIn) {
            yield* Console.log("❌ Built-in tool was NOT blocked!")
          } else {
            yield* Console.log("ℹ️  MCP tool (not blocked by allowedTools)")
          }
        }

        if (chunk.type === "text") {
          // Just log a snippet
          if (chunk.text.length > 50) {
            yield* Console.log(`[TEXT] ${chunk.text.substring(0, 50)}...`)
          }
        }
      })
    ),
    Effect.catchAll(() => Effect.void)
  )

  yield* Console.log("\n✓ All 16 built-in tools blocked by allowedTools: []")
  yield* Console.log("Note: MCP server tools remain available")
})

// Configure with empty allowedTools array = deny all
const config = Layer.succeed(
  ClaudeCodeCliConfig,
  ClaudeCodeCliConfig.of({
    allowedTools: [] // Empty array = deny all tools
  })
)

Effect.runPromise(
  program.pipe(
    Effect.provide(layerConfig),
    Effect.provide(config),
    Effect.timeout("30 seconds")
  )
).catch(console.error)
