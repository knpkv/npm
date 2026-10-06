/**
 * The pi-ai providers Relay registers: `claude-code` and `codex-cli`, each a model turn delegated to
 * the user's own CLI login through {@link runTurn}. Pi's own providers (including its claude.ai and
 * ChatGPT OAuth flows) are never registered; {@link relayModels} is the only way Relay builds its
 * model registry, and it accepts only these ids.
 *
 * This module is the Promise boundary between Pi's generation task and Effect.
 *
 * @module
 */
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type Message,
  type Model,
  type Models,
  type SimpleStreamOptions,
  type TextContent,
  type Tool,
  type ToolCall,
  type TranscriptContext
} from "@earendil-works/pi-ai"
import { Predicate, Schema } from "effect"
import type { RelayBackendId } from "./model.js"
import type { Turn, TurnLine, TurnRequest, TurnTool } from "./turn.js"

/** Runs one turn for the provider; the harness supplies it with its Effect runtime and the CLI layer. */
export type TurnRunner = (request: TurnRequest, signal: AbortSignal | undefined) => Promise<{
  readonly turn: Turn
  readonly callIds: ReadonlyArray<string>
}>

const API = "relay-cli-turn"
const decodeJson = Schema.decodeUnknownOption(Schema.Json)
const MODEL_ID = "default"

const textOf = (content: string | ReadonlyArray<{ readonly type: string; readonly text?: string }>): string =>
  Predicate.isString(content)
    ? content
    : content.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : [])).join("\n")

/** Fold Pi's transcript into instructions, the current tool set, and the visible lines. */
export const turnRequestOf = (messages: ReadonlyArray<Message>): TurnRequest => {
  const instructions: Array<string> = []
  const tools = new Map<string, TurnTool>()
  const transcript: Array<TurnLine> = []
  for (const message of messages) {
    switch (message.role) {
      case "system": {
        const text = textOf(message.content)
        if (text !== "") instructions.push(text)
        for (const section of Object.values(message.sections ?? {})) if (section !== null) instructions.push(section)
        for (const tool of message.toolsAdded ?? []) {
          // Pi's TypeBox schema is plain JSON Schema at runtime; parse it rather than trust the type.
          const parameters = decodeJson(tool.parameters)
          if (parameters._tag === "Some") {
            tools.set(tool.name, { name: tool.name, description: tool.description, parameters: parameters.value })
          }
        }
        for (const removed of message.toolsRemoved ?? []) tools.delete(removed.name)
        break
      }
      case "user":
        transcript.push({ _tag: "User", text: textOf(message.content) })
        break
      case "assistant":
        for (const block of message.content) {
          if (block.type === "text" && block.text !== "") transcript.push({ _tag: "Relay", text: block.text })
          if (block.type === "toolCall") {
            transcript.push({ _tag: "ToolCall", id: block.id, name: block.name, arguments: block.arguments })
          }
        }
        break
      case "toolResult":
        transcript.push({
          _tag: "ToolResult",
          id: message.toolCallId,
          name: message.toolName,
          text: textOf(message.content),
          isError: message.isError === true
        })
        break
    }
  }
  return { instructions: instructions.join("\n\n"), tools: [...tools.values()], transcript }
}

const emptyUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
})

const messageOf = (model: Model<string>, turn: Turn, callIds: ReadonlyArray<string>, now: number): AssistantMessage => {
  const calls = turn.toolCalls.map((call, index): ToolCall => ({
    type: "toolCall",
    id: callIds[index] ?? `call-${index}`,
    name: call.name,
    arguments: call.arguments
  }))
  const reply: ReadonlyArray<TextContent> = turn.reply === "" ? [] : [{ type: "text", text: turn.reply }]
  return {
    role: "assistant",
    content: [...reply, ...calls],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: calls.length > 0 ? "toolUse" : "stop",
    timestamp: now
  }
}

const emit = (stream: AssistantMessageEventStream, message: AssistantMessage): void => {
  const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" }
  stream.push({ type: "start", partial: { ...partial } })
  message.content.forEach((block, index) => {
    if (block.type === "text") {
      partial.content.push({ type: "text", text: "" })
      stream.push({ type: "text_start", contentIndex: index, partial: { ...partial } })
      partial.content[index] = block
      stream.push({ type: "text_delta", contentIndex: index, delta: block.text, partial: { ...partial } })
      stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: { ...partial } })
    } else if (block.type === "toolCall") {
      partial.content.push(block)
      stream.push({ type: "toolcall_start", contentIndex: index, partial: { ...partial } })
      stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: { ...partial } })
    }
  })
  stream.push({
    type: "done",
    reason: message.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
    message
  })
  stream.end(message)
}

const failed = (model: Model<string>, reason: "error" | "aborted", detail: string, now: number): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: emptyUsage(),
  stopReason: reason,
  errorMessage: detail,
  timestamp: now
})

/** A Relay provider: one model, every turn handed to `run`. */
export const relayProvider = (id: RelayBackendId, name: string, run: TurnRunner, now: () => number) =>
  createProvider({
    id,
    name,
    // The CLI holds the user's login; Relay holds no credential, so auth always resolves empty.
    auth: { apiKey: { name, resolve: async () => ({ auth: {} }) } },
    models: [{
      id: MODEL_ID,
      name,
      api: API,
      provider: id,
      baseUrl: "cli:",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 32_000
    }],
    api: {
      stream: (model, context, options) => streamTurn(model, context, options, run, now),
      streamSimple: (model, context, options) => streamTurn(model, context, options, run, now)
    }
  })

const streamTurn = (
  model: Model<string>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  run: TurnRunner,
  now: () => number
): AssistantMessageEventStream => {
  const stream = createAssistantMessageEventStream()
  const signal = options?.signal
  run(turnRequestOf(context.messages), signal).then(
    ({ callIds, turn }) => emit(stream, messageOf(model, turn, callIds, now())),
    (cause: unknown) => {
      const message = failed(model, signal?.aborted === true ? "aborted" : "error", String(cause), now())
      stream.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message })
      stream.end(message)
    }
  )
  return stream
}

/** The only model registry Relay builds: exactly the given Relay providers, nothing from pi-ai's catalog. */
export const relayModels = (providers: ReadonlyArray<ReturnType<typeof relayProvider>>): Models => {
  const models = createModels()
  for (const provider of providers) models.setProvider(provider)
  return models
}

/** The tool declarations Pi reports for a capability, as JSON Schema. */
export type RelayToolDeclaration = Pick<Tool, "name" | "description" | "parameters">
