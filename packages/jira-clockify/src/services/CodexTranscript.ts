/**
 * Normalize Codex rollouts into session lines. Only authoritative user events open a supervised
 * turn: response-item copies also contain injected instructions and replayed compacted history.
 * Completed items continue the turn, `task_complete` and `turn_aborted` end it. Metadata and turn
 * contexts supply the directory; native subagent rollouts supply no human time.
 */
import * as Schema from "effect/Schema"
import type { SessionLine } from "./SessionLine.js"

const TextPart = Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })
const Message = Schema.Struct({
  type: Schema.Literal("message"),
  role: Schema.Literal("assistant"),
  content: Schema.Array(TextPart)
})
const UserEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("user_message"), message: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("item_completed"),
    started_at_ms: Schema.optional(Schema.Number),
    item: Schema.Struct({
      type: Schema.Literal("UserMessage"),
      id: Schema.optional(Schema.String),
      content: Schema.Array(TextPart)
    })
  })
])
/** Any other completed item is the agent working inside the current turn. */
const WorkEvent = Schema.Struct({
  type: Schema.Literal("item_completed"),
  item: Schema.Struct({ type: Schema.String })
})
/**
 * Any other response item — tool calls and their output, reasoning — is the agent working. Older
 * rollouts carry no `item_completed` events, so these are their only evidence that a supervised turn
 * is still running. User- and developer-role messages are copies of prompts or injected instructions:
 * context, never work. No text is kept from any of them.
 */
const WorkItem = Schema.Struct({ type: Schema.String, role: Schema.optional(Schema.String) })
const TurnEndEvent = Schema.Struct({ type: Schema.Literals(["task_complete", "turn_aborted"]) })
const CodexLine = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("session_meta"),
    payload: Schema.Struct({
      id: Schema.String,
      cwd: Schema.String,
      source: Schema.optional(Schema.Json),
      git: Schema.optional(Schema.Struct({ branch: Schema.optional(Schema.String) }))
    })
  }),
  Schema.Struct({
    type: Schema.Literal("turn_context"),
    timestamp: Schema.String,
    payload: Schema.Struct({ cwd: Schema.String })
  }),
  Schema.Struct({ type: Schema.Literal("event_msg"), timestamp: Schema.String, payload: UserEvent }),
  Schema.Struct({ type: Schema.Literal("event_msg"), timestamp: Schema.String, payload: WorkEvent }),
  Schema.Struct({ type: Schema.Literal("event_msg"), timestamp: Schema.String, payload: TurnEndEvent }),
  Schema.Struct({ type: Schema.Literal("response_item"), timestamp: Schema.String, payload: Message }),
  Schema.Struct({ type: Schema.Literal("response_item"), timestamp: Schema.String, payload: WorkItem })
])

const isTurnEnd = Schema.is(TurnEndEvent)
const isAssistantMessage = Schema.is(Message)
const isUserEvent = Schema.is(UserEvent)

/** Discard tool payloads and malformed lines before retaining a rollout in memory. */
export const decodeCodexLine = Schema.decodeUnknownOption(Schema.fromJsonString(CodexLine))

/** The shared transcript segmenter handles time windows, branch changes and directory isolation. */
export function* codexTranscriptLines(lines: Iterable<typeof CodexLine.Type>): Generator<SessionLine> {
  let sessionId: string | null = null
  let cwd: string | null = null
  let gitBranch: string | null = null
  const seen = new Set<string>()
  for (const line of lines) {
    if (line.type === "session_meta") {
      const source = line.payload.source
      if (source !== undefined && source !== "cli" && source !== "vscode") return
      sessionId = line.payload.id
      cwd = line.payload.cwd
      gitBranch = line.payload.git?.branch ?? null
      continue
    }
    if (sessionId === null || cwd === null) continue
    const base = { sessionId, gitBranch }
    if (line.type === "turn_context") {
      // A branch recorded for the old directory cannot place work in the new one.
      if (cwd !== line.payload.cwd) gitBranch = null
      cwd = line.payload.cwd
      yield { ...base, gitBranch, cwd, atMs: Date.parse(line.timestamp), text: "", presence: "context" }
      continue
    }
    if (line.type === "response_item") {
      const payload = line.payload
      const atMs = Date.parse(line.timestamp)
      if (isAssistantMessage(payload)) {
        const text = payload.content.filter((part) => part.type === "output_text").map((part) => part.text ?? "")
          .join("\n")
        yield { ...base, cwd, atMs, text, presence: "work" }
      } else {
        const copy = payload.type === "message" && payload.role !== "assistant"
        yield { ...base, cwd, atMs, text: "", presence: copy ? "context" : "work" }
      }
      continue
    }
    const event = line.payload
    if (isTurnEnd(event)) {
      yield { ...base, cwd, atMs: Date.parse(line.timestamp), text: "", presence: "turn-end" }
      continue
    }
    if (!isUserEvent(event)) {
      yield { ...base, cwd, atMs: Date.parse(line.timestamp), text: "", presence: "work" }
      continue
    }
    const text = event.type === "user_message"
      ? event.message
      : event.item.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n")
    const atMs = event.type === "item_completed"
      ? event.started_at_ms ?? Date.parse(line.timestamp)
      : Date.parse(line.timestamp)
    if (Number.isNaN(new Date(atMs).getTime())) continue
    const identity = event.type === "item_completed" && event.item.id !== undefined
      ? event.item.id
      : `${String(atMs)}:${text}`
    if (seen.has(identity)) continue
    seen.add(identity)
    yield { ...base, cwd, atMs, text, presence: "prompt" }
  }
}
