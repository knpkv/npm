import { Effect, Schema } from "effect"
import type * as Response from "effect/unstable/ai/Response"
import { CodexFailureCause, CodexTransportError, sanitizeDiagnostic } from "./errors.js"

const CodexUsage = Schema.Struct({
  cached_input_tokens: Schema.optional(Schema.Number),
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  reasoning_output_tokens: Schema.optional(Schema.Number)
})

const CodexItem = Schema.Struct({
  text: Schema.optional(Schema.String),
  type: Schema.String
})

const CodexFailure = Schema.Struct({
  message: Schema.optional(Schema.String)
})

const CodexEvent = Schema.Struct({
  error: Schema.optional(CodexFailure),
  item: Schema.optional(CodexItem),
  message: Schema.optional(Schema.String),
  thread_id: Schema.optional(Schema.String),
  type: Schema.String,
  usage: Schema.optional(CodexUsage)
})

type CodexEvent = typeof CodexEvent.Type

export interface CodexTurn {
  readonly text: string
  readonly threadId: string | undefined
  readonly usage: Response.FinishPartEncoded["usage"]
}

const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexEvent))

const protocolError = (diagnostic: string, cause: unknown): CodexTransportError =>
  new CodexTransportError({
    cause,
    diagnostic: sanitizeDiagnostic(diagnostic),
    phase: "protocol"
  })

export const decodeTranscript = Effect.fn("CodexProtocol.decodeTranscript")(function*(stdout: string) {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0)
  const events = yield* Effect.forEach(lines, (line) =>
    decodeEvent(line).pipe(
      Effect.mapError((cause) => protocolError("Codex emitted malformed JSONL", cause))
    ))

  let threadId: string | undefined
  let usage: CodexEvent["usage"]
  let message: string | undefined

  for (const event of events) {
    if (event.type === "thread.started") threadId = event.thread_id
    if (event.type === "turn.completed") usage = event.usage
    if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text !== undefined) {
      message = event.item.text
    }
    if (event.type === "turn.failed" || event.type === "error") {
      const diagnostic = event.error?.message ?? event.message ?? "Codex turn failed"
      return yield* protocolError(diagnostic, new CodexFailureCause({ reason: "failed-turn" }))
    }
  }

  if (message === undefined) {
    return yield* protocolError(
      "Codex completed without an agent message",
      new CodexFailureCause({ reason: "missing-agent-message" })
    )
  }

  return {
    text: message,
    threadId,
    usage: {
      inputTokens: {
        cacheRead: usage?.cached_input_tokens,
        cacheWrite: undefined,
        total: usage?.input_tokens,
        uncached: usage?.input_tokens === undefined
          ? undefined
          : Math.max(0, usage.input_tokens - (usage.cached_input_tokens ?? 0))
      },
      outputTokens: {
        reasoning: usage?.reasoning_output_tokens,
        text: usage?.output_tokens === undefined
          ? undefined
          : Math.max(0, usage.output_tokens - (usage.reasoning_output_tokens ?? 0)),
        total: usage?.output_tokens
      }
    }
  } satisfies CodexTurn
})
