/**
 * One model turn over a CLI-backed `LanguageModel`, with tool calls carried in a JSON schema.
 *
 * **Mental model**
 *
 * - **The CLI never runs tools.** `claude --print` and `codex exec` are asked for one structured
 *   answer: either tool calls or a final reply. The harness runs the tools, behind its gate, and the
 *   next turn sees their results. That keeps the user's own CLI login as the only credential and the
 *   permission gate as the only path to a product.
 * - **The transcript is rendered, not replayed into provider sessions.** Each turn gets the whole
 *   visible transcript, so switching backends mid-session needs no provider state.
 *
 * @module
 */
import { Effect, Schema } from "effect"
import { LanguageModel } from "effect/ai"

/** A tool as the model is told about it. */
export interface TurnTool {
  readonly name: string
  readonly description: string
  readonly parameters: Schema.Json
}

/** One transcript line as the model reads it. */
export type TurnLine =
  | { readonly _tag: "User"; readonly text: string }
  | { readonly _tag: "Relay"; readonly text: string }
  | { readonly _tag: "ToolCall"; readonly id: string; readonly name: string; readonly arguments: Schema.Json }
  | {
    readonly _tag: "ToolResult"
    readonly id: string
    readonly name: string
    readonly text: string
    readonly isError: boolean
  }

export interface TurnRequest {
  readonly instructions: string
  readonly tools: ReadonlyArray<TurnTool>
  readonly transcript: ReadonlyArray<TurnLine>
}

/** What the model returns for one turn. An empty `toolCalls` means `reply` is the final answer. */
export const Turn = Schema.Struct({
  reply: Schema.String,
  toolCalls: Schema.Array(Schema.Struct({ name: Schema.String, arguments: Schema.Record(Schema.String, Schema.Json) }))
})
export type Turn = typeof Turn.Type

const renderLine = (line: TurnLine): string => {
  switch (line._tag) {
    case "User":
      return `USER: ${line.text}`
    case "Relay":
      return `RELAY: ${line.text}`
    case "ToolCall":
      return `RELAY CALLED ${line.name} (${line.id}) WITH ${JSON.stringify(line.arguments)}`
    case "ToolResult":
      return `${line.isError ? "TOOL ERROR" : "TOOL RESULT"} ${line.name} (${line.id}): ${line.text}`
  }
}

/** The prompt one turn sends: instructions, the tool list with schemas, the transcript, the answer rule. */
export const renderTurnPrompt = (request: TurnRequest): string =>
  [
    request.instructions,
    "",
    request.tools.length === 0
      ? "You have no tools in this session."
      : [
        "Tools you may call (arguments must match the JSON Schema):",
        ...request.tools.map((tool) =>
          `- ${tool.name}: ${tool.description}\n  schema: ${JSON.stringify(tool.parameters)}`
        )
      ].join("\n"),
    "",
    "Conversation so far:",
    ...request.transcript.map(renderLine),
    "",
    "Answer with one JSON object. To call tools, list them in toolCalls and keep reply short or empty.",
    "To answer the user, leave toolCalls empty and put the whole answer in reply.",
    "Never claim an action happened unless a TOOL RESULT says so."
  ].join("\n")

/** Run one turn on whatever `LanguageModel` is provided: the user's Claude Code or Codex CLI. */
export const runTurn = Effect.fn("Relay.runTurn")(function*(request: TurnRequest) {
  const response = yield* LanguageModel.generateObject({
    prompt: renderTurnPrompt(request),
    schema: Turn,
    objectName: "relay_turn"
  })
  return response.value
})
