/**
 * Service composition example.
 *
 * Demonstrates building custom services on top of ClaudeAgentClient.
 */
import { Console, Context, Effect, Layer } from "effect"
import * as AgentClient from "../src/index.js"

// Define a custom service that depends on ClaudeAgentClient
interface AnalysisService {
  readonly analyze: (code: string) => Effect.Effect<string, AgentClient.ClaudeAgentError.AgentError, never>
}

const AnalysisService = Context.GenericTag<AnalysisService>("@example/AnalysisService")

// Implement the service using ClaudeAgentClient
const makeAnalysisService = Effect.gen(function*() {
  const client = yield* AgentClient.ClaudeAgentClient.ClaudeAgentClient

  return AnalysisService.of({
    analyze: (code) =>
      Effect.gen(function*() {
        const result = yield* client.queryText({
          prompt: `Analyze this code and provide feedback:\n\n${code}`
        })
        return result
      })
  })
})

const AnalysisServiceLive = Layer.effect(AnalysisService, makeAnalysisService)

// Use the composed services
const program = Effect.gen(function*() {
  yield* Console.log("=== Service Composition Example ===\n")

  const analysisService = yield* AnalysisService

  yield* Console.log("Analyzing code with composed services...\n")

  const feedback = yield* analysisService.analyze(`
function add(a, b) {
  return a + b
}
  `)

  yield* Console.log("Feedback:")
  yield* Console.log("---")
  yield* Console.log(feedback)
  yield* Console.log("---")
})

// Compose all layers
const AppLayer = AnalysisServiceLive.pipe(Layer.provide(AgentClient.ClaudeAgentClient.layer()))

Effect.runPromise(
  program.pipe(Effect.provide(AppLayer), Effect.timeout("30 seconds"))
).catch(console.error)
