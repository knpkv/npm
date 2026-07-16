import { Effect } from "effect"
import type * as Prompt from "effect/unstable/ai/Prompt"
import { invalidRequest } from "./errors.js"

const renderParts = (
  method: string,
  parts: ReadonlyArray<Prompt.UserMessagePart | Prompt.AssistantMessagePart>
): Effect.Effect<string, ReturnType<typeof invalidRequest>> =>
  Effect.gen(function*() {
    const rendered: Array<string> = []
    for (const part of parts) {
      switch (part.type) {
        case "text":
        case "reasoning": {
          rendered.push(part.text)
          break
        }
        case "file": {
          return yield* invalidRequest(
            method,
            "prompt",
            "File prompt parts are not supported by the Codex CLI model"
          )
        }
        default: {
          return yield* invalidRequest(
            method,
            "prompt",
            "Tool and approval prompt parts are not supported by the Codex CLI model"
          )
        }
      }
    }
    return rendered.join("\n")
  })

export const renderPrompt = (
  method: string,
  prompt: Prompt.Prompt
): Effect.Effect<string, ReturnType<typeof invalidRequest>> =>
  Effect.gen(function*() {
    const messages: Array<string> = []
    for (const message of prompt.content) {
      switch (message.role) {
        case "system": {
          messages.push(`SYSTEM\n${message.content}`)
          break
        }
        case "user":
        case "assistant": {
          const content = yield* renderParts(method, message.content)
          messages.push(`${message.role.toUpperCase()}\n${content}`)
          break
        }
        case "tool": {
          return yield* invalidRequest(
            method,
            "prompt",
            "Tool messages are not supported by the Codex CLI model"
          )
        }
      }
    }
    return messages.join("\n\n")
  })
