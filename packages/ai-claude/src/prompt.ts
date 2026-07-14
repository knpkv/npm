import { Effect } from "effect"
import type { LanguageModel, Prompt } from "effect/unstable/ai"
import { invalidInput } from "./errors.js"

const renderTextParts = (
  parts: ReadonlyArray<Prompt.Part>,
  method: string
): Effect.Effect<string, ReturnType<typeof invalidInput>> =>
  Effect.gen(function*() {
    const rendered: Array<string> = []
    for (const part of parts) {
      switch (part.type) {
        case "reasoning":
        case "text": {
          rendered.push(part.text)
          break
        }
        default: {
          return yield* invalidInput(
            `Claude CLI does not support ${part.type} prompt parts`,
            method
          )
        }
      }
    }
    return rendered.join("\n")
  })

export const renderPrompt = (
  options: LanguageModel.ProviderOptions,
  method: string
): Effect.Effect<string, ReturnType<typeof invalidInput>> =>
  Effect.gen(function*() {
    if (options.tools.length > 0) {
      return yield* invalidInput("Effect AI toolkits are not supported by the Claude CLI adapter", method)
    }

    const messages: Array<string> = []
    for (const message of options.prompt.content) {
      if (message.role === "system") {
        messages.push(`System:\n${message.content}`)
        continue
      }
      if (message.role === "tool") {
        return yield* invalidInput("Effect AI tool messages are not supported by the Claude CLI adapter", method)
      }

      const content = yield* renderTextParts(message.content, method)
      const role = message.role === "assistant" ? "Assistant" : "User"
      messages.push(`${role}:\n${content}`)
    }

    return messages.join("\n\n")
  })
