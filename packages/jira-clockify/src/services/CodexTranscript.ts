/**
 * Normalize Codex rollouts into session messages. Only authoritative user events count as
 * presence: response-item copies also contain injected instructions and replayed compacted history.
 * Metadata and turn contexts supply the directory; native subagent rollouts supply no human time.
 */
import * as Schema from "effect/Schema"

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
  Schema.Struct({ type: Schema.Literal("response_item"), timestamp: Schema.String, payload: Message })
])

/** Discard tool payloads and malformed lines before retaining a rollout in memory. */
export const decodeCodexLine = Schema.decodeUnknownOption(Schema.fromJsonString(CodexLine))

/** The shared transcript segmenter handles time windows, branch changes and directory isolation. */
export function* codexTranscriptLines(lines: Iterable<typeof CodexLine.Type>) {
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
    if (line.type === "turn_context") {
      // A branch recorded for the old directory cannot place work in the new one.
      if (cwd !== line.payload.cwd) gitBranch = null
      cwd = line.payload.cwd
      yield { type: "assistant", sessionId, cwd, gitBranch, timestamp: line.timestamp, message: { content: "" } }
      continue
    }
    if (line.type === "response_item") {
      const content = line.payload.content.filter((part) => part.type === "output_text").map((part) => part.text ?? "")
        .join("\n")
      yield { type: "assistant", sessionId, cwd, gitBranch, timestamp: line.timestamp, message: { content } }
      continue
    }
    const event = line.payload
    const content = event.type === "user_message"
      ? event.message
      : event.item.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n")
    const atMs = event.type === "item_completed"
      ? event.started_at_ms ?? Date.parse(line.timestamp)
      : Date.parse(line.timestamp)
    const instant = new Date(atMs)
    if (Number.isNaN(instant.getTime())) continue
    const identity = event.type === "item_completed" && event.item.id !== undefined
      ? event.item.id
      : `${String(atMs)}:${content}`
    if (seen.has(identity)) continue
    seen.add(identity)
    yield { type: "user", sessionId, cwd, gitBranch, timestamp: instant.toISOString(), message: { content } }
  }
}
