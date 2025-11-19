/**
 * Language Model example.
 *
 * Demonstrates @effect/ai LanguageModel integration.
 */
import { LanguageModel } from "@effect/ai"
import { Console, Effect, Stream } from "effect"
import * as AgentClient from "../src/index.js"

// Example 1: Generate text with LanguageModel
const generateTextExample = Effect.gen(function*() {
  yield* Console.log("=== Generate Text Example ===\n")

  const model = yield* LanguageModel.LanguageModel
  const response = yield* model.generateText({
    prompt: [
      { role: "user", content: [{ type: "text", text: "Explain Effect-TS in one sentence" }] }
    ]
  })

  yield* Console.log("Response:")
  yield* Console.log("---")
  yield* Console.log(response.text)
  yield* Console.log("---")
  yield* Console.log("Usage:", response.usage)
})

// Example 2: Stream text with LanguageModel
const streamTextExample = Effect.gen(function*() {
  yield* Console.log("\n=== Stream Text Example ===\n")

  const model = yield* LanguageModel.LanguageModel
  const stream = model.streamText({
    prompt: [
      { role: "user", content: [{ type: "text", text: "Write a haiku about functional programming" }] }
    ]
  })

  yield* Console.log("Streaming response:")
  yield* Console.log("---")
  yield* stream.pipe(
    Stream.runForEach((part: any) =>
      Effect.gen(function*() {
        if (part.type === "text-delta") {
          yield* Console.log(part.delta)
        } else if (part.type === "finish") {
          yield* Console.log("\n---")
          yield* Console.log("Finish reason:", part.reason)
          yield* Console.log("Usage:", part.usage)
        }
      })
    )
  )
})

// Example 3: Multi-turn conversation
const conversationExample = Effect.gen(function*() {
  yield* Console.log("Conversation Example")

  const model = yield* LanguageModel.LanguageModel

  // First turn
  const response1 = yield* model.generateText({
    prompt: [
      { role: "user", content: [{ type: "text", text: "What is a monad?" }] }
    ]
  })
  yield* Console.log("User: What is a monad?")
  yield* Console.log("Assistant:", response1.text)

  // Second turn with history
  const response2 = yield* model.generateText({
    prompt: [
      { role: "user", content: [{ type: "text", text: "What is a monad?" }] },
      { role: "assistant", content: [{ type: "text", text: response1.text }] },
      { role: "user", content: [{ type: "text", text: "Can you give an example in TypeScript?" }] }
    ]
  })
  yield* Console.log("\nUser: Can you give an example in TypeScript?")
  yield* Console.log("Assistant:", response2.text)
})

// Run all examples
const program = Effect.gen(function*() {
  yield* generateTextExample
  yield* streamTextExample
  yield* conversationExample
  return void 0
})

// Provide layers
Effect.runPromise(
  program.pipe(
    Effect.provide(AgentClient.ClaudeAgentLanguageModel.layer()),
    Effect.provide(AgentClient.ClaudeAgentClient.layer())
  )
).catch(console.error)
