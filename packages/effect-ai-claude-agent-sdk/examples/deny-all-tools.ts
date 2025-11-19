/**
 * Empty allowedTools array example for SDK.
 *
 * Demonstrates that allowedTools: [] successfully denies all tools.
 */
import { Console, Effect, Stream } from "effect"
import * as AgentConfig from "../src/ClaudeAgentConfig.js"
import * as AgentClient from "../src/index.js"

const program = Effect.gen(function*() {
  const client = yield* AgentClient.ClaudeAgentClient.ClaudeAgentClient

  yield* Console.log("Testing allowedTools: [] (should deny all tools)...\n")

  const stream = client.query({
    prompt: "Read the package.json file and tell me the package name",
    allowedTools: [] // Empty array = deny all tools (converted to disallowedTools: allTools)
  })

  let toolsUsed = 0

  yield* stream.pipe(
    Stream.runForEach((message) =>
      Effect.gen(function*() {
        if (message.type === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
          for (const toolCall of message.toolCalls) {
            toolsUsed++
            yield* Console.log(`[TOOL USED] ${(toolCall as any).name}`)
          }
        }

        if (message.type === "assistant" && message.content) {
          const snippet = message.content.substring(0, 100)
          if (snippet.length > 0) {
            yield* Console.log(`[TEXT] ${snippet}${message.content.length > 100 ? "..." : ""}`)
          }
        }
      })
    )
  )

  yield* Console.log(
    toolsUsed > 0
      ? `\n❌ ERROR: ${toolsUsed} tool(s) used despite allowedTools: []`
      : "\n✓ All tools correctly blocked by allowedTools: []"
  )
})

// Config with empty allowedTools = deny all
const config = AgentConfig.layer({
  allowedTools: [] // Empty array = deny all tools
})

Effect.runPromise(
  program.pipe(
    Effect.provide(AgentClient.ClaudeAgentClient.layerConfig()),
    Effect.provide(config),
    Effect.timeout("30 seconds")
  )
).catch(console.error)
