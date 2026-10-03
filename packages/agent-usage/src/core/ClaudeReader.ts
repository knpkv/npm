/**
 * Reading Claude Code transcripts (`<config>/projects/<project>/<session>.jsonl`, and each session's
 * `subagents/*.jsonl`, booked to the parent session) into Usage Events.
 *
 * **Mental model**
 *
 * - **One event per model request.** Claude Code writes a message once per content block, each line
 *   repeating the usage; message id + request id dedupes them, and the store's key absorbs repeats
 *   across chunks and re-reads.
 * - **Zero-token messages are placeholders** (`<synthetic>` local replies), not requests.
 * - **The Active Ticket follows the human.** Each typed user turn sets it to the one ticket it names,
 *   or clears it; tool results, meta turns and injected reminders never touch it.
 * - **Prompt and response text is read here and dropped here.** Nothing but counts and metadata
 *   leaves this module.
 *
 * @module
 */
import { Option, Predicate, Schema } from "effect"
import { type ClaudeContent, claudeHumanText, singleTicket } from "./Attribution.js"
import { Count, type UsageEvent } from "./Model.js"
import { countSkip, noSkips, parseInstant, type ReadResult, type SourceFile, type SourceLine } from "./Readers.js"

export const ClaudeReaderState = Schema.Struct({ activeTicket: Schema.NullOr(Schema.String) })
export type ClaudeReaderState = typeof ClaudeReaderState.Type

export const initialClaudeState: ClaudeReaderState = { activeTicket: null }

const Usage = Schema.Struct({
  input_tokens: Schema.optionalKey(Count),
  output_tokens: Schema.optionalKey(Count),
  cache_read_input_tokens: Schema.optionalKey(Count),
  cache_creation_input_tokens: Schema.optionalKey(Count),
  cache_creation: Schema.optionalKey(Schema.Struct({
    ephemeral_5m_input_tokens: Schema.optionalKey(Count),
    ephemeral_1h_input_tokens: Schema.optionalKey(Count)
  })),
  speed: Schema.optionalKey(Schema.NullOr(Schema.String))
})

const AssistantLine = Schema.Struct({
  timestamp: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  gitBranch: Schema.optionalKey(Schema.String),
  requestId: Schema.optionalKey(Schema.String),
  message: Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    model: Schema.NonEmptyString,
    usage: Usage
  })
})

const UserLine = Schema.Struct({
  type: Schema.Literal("user"),
  isMeta: Schema.optionalKey(Schema.Boolean),
  message: Schema.Struct({
    content: Schema.Union([
      Schema.String,
      Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }))
    ])
  })
})

const decodeAssistant = Schema.decodeUnknownOption(Schema.fromJsonString(AssistantLine))
const decodeUser = Schema.decodeUnknownOption(Schema.fromJsonString(UserLine))

const isToolResultTurn = (content: ClaudeContent): boolean =>
  !Predicate.isString(content) && content.length > 0 && content.every((block) => block.type === "tool_result")

type Assistant = typeof AssistantLine.Type

const toEvent = (
  file: SourceFile,
  line: SourceLine,
  record: Assistant,
  occurredAt: number,
  activeTicket: string | null
): UsageEvent | null => {
  const usage = record.message.usage
  const write5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0
  // Older records carry only the total; those count at the 5-minute rate.
  const split = write5m + write1h > 0
  const tokens = {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    reasoning: 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite5m: split ? write5m : usage.cache_creation_input_tokens ?? 0,
    cacheWrite1h: split ? write1h : 0
  }
  if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h === 0) return null
  const messageId = record.message.id ?? ""
  const requestId = record.requestId ?? ""
  return {
    agent: "claude",
    dedupeKey: messageId === "" && requestId === ""
      ? `${file.fileKey}#${line.offset}`
      : `${messageId} ${requestId}`,
    machine: file.machine,
    sessionId: file.sessionId,
    occurredAt,
    model: record.message.model,
    fast: usage.speed === "fast",
    tokens,
    attribution: { cwd: record.cwd ?? "", branch: record.gitBranch ?? "", activeTicket }
  }
}

/** Reads one chunk of a transcript, continuing from the state the previous chunk ended in. */
export const readClaude = (
  file: SourceFile,
  lines: ReadonlyArray<SourceLine>,
  state: ClaudeReaderState
): ReadResult<ClaudeReaderState> => {
  const events: Array<UsageEvent> = []
  const seen = new Set<string>()
  let skipped = noSkips
  let activeTicket = state.activeTicket

  for (const line of lines) {
    if (line.text.includes("\"type\":\"user\"")) {
      const user = decodeUser(line.text)
      if (Option.isSome(user)) {
        const content = user.value.message.content
        if (user.value.isMeta !== true && !isToolResultTurn(content)) {
          const typed = claudeHumanText(content)
          if (typed !== "") activeTicket = singleTicket(typed)
        }
        continue
      }
    }
    if (!line.text.includes("\"usage\"")) continue
    const assistant = decodeAssistant(line.text)
    if (Option.isNone(assistant)) {
      skipped = countSkip(skipped, "unparseableLine")
      continue
    }
    const occurredAt = parseInstant(assistant.value.timestamp ?? "")
    if (occurredAt === null) {
      skipped = countSkip(skipped, "missingTimestamp")
      continue
    }
    const event = toEvent(file, line, assistant.value, occurredAt, activeTicket)
    if (event === null || seen.has(event.dedupeKey)) continue
    seen.add(event.dedupeKey)
    events.push(event)
  }

  return { events, snapshots: [], balances: [], skipped, state: { activeTicket } }
}
