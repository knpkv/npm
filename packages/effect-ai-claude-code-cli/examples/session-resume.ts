/**
 * Session resume example.
 *
 * Demonstrates how to discover and resume existing Claude Code sessions.
 */
import { NodeFileSystem } from "@effect/platform-node"
import { Array, Console, Effect, Order, Stream } from "effect"
import { ClaudeCodeCliClient, layer } from "../src/ClaudeCodeCliClient.js"
import { ClaudeCodeCliConfig } from "../src/ClaudeCodeCliConfig.js"
import * as SessionDiscovery from "../src/SessionDiscovery.js"

const program = Effect.gen(function*() {
  yield* Console.log("=== Session Resume Example ===\n")

  // List all sessions for the current project
  yield* Console.log("Discovering sessions for current project...")
  const sessions = yield* SessionDiscovery.listProjectSessions(process.cwd())

  if (sessions.length === 0) {
    yield* Console.log("No sessions found. Start a conversation first to create a session.")
    return
  }

  yield* Console.log(`Found ${sessions.length} session(s)\n`)

  // Sort by most recent (descending timestamp)
  const byTimestamp = Order.mapInput(Order.number, (session: SessionDiscovery.SessionRecord) => session.timestamp)
  const sortedSessions = Array.sort(sessions, Order.reverse(byTimestamp))

  // Display sessions
  for (const session of sortedSessions) {
    const date = new Date(session.timestamp).toLocaleString()
    yield* Console.log(`- Session ID: ${session.sessionId}`)
    yield* Console.log(`  Last modified: ${date}`)
    yield* Console.log(`  Project: ${session.projectPath}\n`)
  }

  // Use the most recent session
  const mostRecent = sortedSessions[0]
  yield* Console.log(`Resuming most recent session: ${mostRecent.sessionId}\n`)

  const client = yield* ClaudeCodeCliClient

  // Resume with a simple query
  yield* Console.log("Sending query to resumed session...")
  const response = yield* client.resumeQuery(
    "What were we discussing?",
    mostRecent.sessionId
  )

  yield* Console.log("Response:")
  yield* Console.log("---")
  yield* Console.log(response)
  yield* Console.log("---\n")

  // Resume with streaming
  yield* Console.log("Resuming with streaming query...")
  const stream = client.resumeQueryStream(
    "Continue our conversation",
    mostRecent.sessionId
  )

  yield* Console.log("Streaming response chunks:\n")
  yield* stream.pipe(
    Stream.runForEach((chunk) =>
      Effect.gen(function*() {
        if (chunk.type === "text") {
          yield* Console.log(`[text] ${chunk.text}`)
        } else if (chunk.type === "content_block_start") {
          yield* Console.log(`[block_start] blockType=${chunk.blockType}`)
        } else if (chunk.type === "content_block_stop") {
          yield* Console.log("[block_stop]")
        }
      })
    )
  )

  yield* Console.log("\nSession resume complete!")
})

// Run the program with required layers
Effect.runPromise(
  program.pipe(
    Effect.provide(NodeFileSystem.layer),
    Effect.provide(layer()),
    Effect.provide(ClaudeCodeCliConfig.default)
  )
).catch(console.error)
