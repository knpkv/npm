/**
 * Language Model example.
 *
 * Demonstrates @effect/ai LanguageModel integration.
 *
 * @since 1.0.0
 */
import { LanguageModel } from "@effect/ai"
import { ClaudeCodeCliClient, ClaudeCodeCliConfig, ClaudeCodeCliLanguageModel } from "@knpkv/effect-ai-claude-code-cli"
import { Effect, Stream } from "effect"

// Example 1: Generate text with LanguageModel
const generateTextExample = Effect.gen(function*() {
  console.log("🤖 === Generate Text Example ===\n")

  const model = yield* LanguageModel.LanguageModel
  const response = yield* model.generateText({
    prompt: [
      { role: "user", content: "Explain Effect-TS in one sentence" }
    ]
  })

  console.log("📝 Response:")
  console.log("---")
  console.log(response.text)
  console.log("---")
  console.log("📊 Usage:", response.usage)
})

// Example 2: Stream text with LanguageModel
const streamTextExample = Effect.gen(function*() {
  console.log("\n🤖 === Stream Text Example ===\n")

  const model = yield* LanguageModel.LanguageModel
  const stream = yield* model.streamText({
    prompt: [
      { role: "user", content: "Write a haiku about functional programming" }
    ]
  }) as any

  console.log("📡 Streaming response:")
  console.log("---")
  yield* stream.pipe(
    Stream.runForEach((part: any) =>
      Effect.sync(() => {
        if (part.type === "text-delta") {
          process.stdout.write(part.delta)
        } else if (part.type === "finish") {
          console.log("\n---")
          console.log("✅ Finish reason:", part.reason)
          console.log("📊 Usage:", part.usage)
        }
      })
    )
  )
})

// Example 3: Multi-turn conversation
const conversationExample = Effect.gen(function*() {
  console.log("\n🤖 === Conversation Example ===\n")

  const model = yield* LanguageModel.LanguageModel

  // First turn
  const response1 = yield* model.generateText({
    prompt: [
      { role: "user", content: "What is a monad?" }
    ]
  })
  console.log("👤 User: What is a monad?")
  console.log("🤖 Assistant:", response1.text)

  // Second turn with history
  const response2 = yield* model.generateText({
    prompt: [
      { role: "user", content: "What is a monad?" },
      { role: "assistant", content: response1.text },
      { role: "user", content: "Can you give an example in TypeScript?" }
    ]
  })
  console.log("\n👤 User: Can you give an example in TypeScript?")
  console.log("🤖 Assistant:", response2.text)
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
    Effect.provide(ClaudeCodeCliLanguageModel.layer()),
    Effect.provide(ClaudeCodeCliClient.layer()),
    Effect.provide(ClaudeCodeCliConfig.ClaudeCodeCliConfig.default)
  ) as any
).catch(console.error)
