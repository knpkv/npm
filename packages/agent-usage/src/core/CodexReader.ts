/**
 * Reading Codex rollouts (`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`) into Usage Events,
 * Limit Snapshots and credit Balance Readings.
 *
 * **Mental model**
 *
 * - **A rollout is a running log.** `session_meta` names the cwd and branch, `turn_context` the
 *   model, and every `token_count` carries the request's own usage (`last_token_usage`) beside the
 *   session's running total. Those three facts live in the carried state, so a chunk read on the next
 *   pass books its requests exactly as one long read would.
 * - **A repeated token_count is not a request.** Codex re-emits the event when only rate limits
 *   change; the running total not moving is how that shows.
 * - **Only the `codex` limit is the account's.** Model-scoped limits arrive in their own blocks and
 *   are not the weekly or five-hour allowance; they are ignored here.
 * - **Every token_count backfills limit history**, so Codex limits are recoverable from old rollouts
 *   in a way Claude's are not.
 *
 * @module
 */
import { Option, Schema } from "effect"
import { codexHumanText, singleTicket } from "./Attribution.js"
import { classifyCodexCredits, CodexCredits } from "./Balances.js"
import { type BalanceReading, Count, type LimitSnapshot, type UsageEvent } from "./Model.js"
import { countSkip, noSkips, parseInstant, type ReadResult, type SourceFile, type SourceLine } from "./Readers.js"

export const CodexReaderState = Schema.Struct({
  cwd: Schema.String,
  branch: Schema.String,
  model: Schema.NullOr(Schema.String),
  activeTicket: Schema.NullOr(Schema.String),
  /** The session's running token total at the last token_count read. */
  lastTotal: Schema.NullOr(Count)
})
export type CodexReaderState = typeof CodexReaderState.Type

export const initialCodexState: CodexReaderState = {
  cwd: "",
  branch: "",
  model: null,
  activeTicket: null,
  lastTotal: null
}

const TokenUsage = Schema.Struct({
  input_tokens: Count,
  cached_input_tokens: Schema.optionalKey(Count),
  cache_write_input_tokens: Schema.optionalKey(Count),
  output_tokens: Count,
  reasoning_output_tokens: Schema.optionalKey(Count),
  total_tokens: Count
})

const Window = Schema.Struct({
  used_percent: Schema.Finite,
  window_minutes: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  resets_at: Schema.optionalKey(Schema.NullOr(Schema.Finite))
})

const RateLimits = Schema.Struct({
  limit_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  primary: Schema.optionalKey(Schema.NullOr(Window)),
  secondary: Schema.optionalKey(Schema.NullOr(Window)),
  credits: Schema.optionalKey(Schema.NullOr(CodexCredits))
})

const RolloutLine = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("session_meta"),
    payload: Schema.Struct({
      cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
      git: Schema.optionalKey(
        Schema.NullOr(Schema.Struct({ branch: Schema.optionalKey(Schema.NullOr(Schema.String)) }))
      )
    })
  }),
  Schema.Struct({
    type: Schema.Literal("turn_context"),
    payload: Schema.Struct({
      model: Schema.optionalKey(Schema.NullOr(Schema.String)),
      cwd: Schema.optionalKey(Schema.NullOr(Schema.String))
    })
  }),
  Schema.Struct({
    type: Schema.Literal("response_item"),
    payload: Schema.Struct({
      type: Schema.Literal("message"),
      role: Schema.Literal("user"),
      content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }))
    })
  }),
  Schema.Struct({
    type: Schema.Literal("event_msg"),
    timestamp: Schema.String,
    payload: Schema.Struct({
      type: Schema.Literal("token_count"),
      info: Schema.optionalKey(Schema.NullOr(Schema.Struct({
        total_token_usage: TokenUsage,
        last_token_usage: TokenUsage
      }))),
      rate_limits: Schema.optionalKey(Schema.NullOr(RateLimits))
    })
  })
])

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(RolloutLine))

/** Lines a decode is spent on; everything else in a rollout is conversation or tool traffic. */
const RELEVANT = ["\"session_meta\"", "\"turn_context\"", "\"token_count\"", "\"role\":\"user\""]
const mayMatter = (text: string): boolean => RELEVANT.some((marker) => text.includes(marker))

/** User-role response items that fail to decode are other item kinds; only these count as damage. */
const mustDecode = (text: string): boolean =>
  text.includes("\"session_meta\"") || text.includes("\"turn_context\"") || text.includes("\"token_count\"")

const snapshotsOf = (
  file: SourceFile,
  observedAt: number,
  limits: typeof RateLimits.Type
): ReadonlyArray<LimitSnapshot> => {
  const windows = [["primary", limits.primary], ["secondary", limits.secondary]] as const
  return windows.flatMap(([label, window]) =>
    window === undefined || window === null
      ? []
      : [{
        agent: "codex" as const,
        machine: file.machine,
        source: "codex-rollout" as const,
        label,
        windowMinutes: window.window_minutes !== undefined && window.window_minutes !== null &&
            window.window_minutes > 0
          ? window.window_minutes
          : null,
        observedAt,
        reading: {
          _tag: "Known" as const,
          usedPercent: window.used_percent,
          resetsAt: window.resets_at === undefined || window.resets_at === null
            ? null
            : Math.round(window.resets_at * 1000)
        }
      }]
  )
}

/** Reads one chunk of a rollout, continuing from the state the previous chunk ended in. */
export const readCodex = (
  file: SourceFile,
  lines: ReadonlyArray<SourceLine>,
  initial: CodexReaderState
): ReadResult<CodexReaderState> => {
  const events: Array<UsageEvent> = []
  const snapshots: Array<LimitSnapshot> = []
  const balances: Array<BalanceReading> = []
  let skipped = noSkips
  let state = initial

  for (const line of lines) {
    if (!mayMatter(line.text)) continue
    const decoded = decodeLine(line.text)
    if (Option.isNone(decoded)) {
      if (mustDecode(line.text)) skipped = countSkip(skipped, "unparseableLine")
      continue
    }
    const record = decoded.value
    switch (record.type) {
      case "session_meta": {
        state = {
          ...state,
          cwd: record.payload.cwd ?? state.cwd,
          branch: record.payload.git?.branch ?? state.branch
        }
        break
      }
      case "turn_context": {
        state = {
          ...state,
          model: record.payload.model ?? state.model,
          cwd: state.cwd === "" ? record.payload.cwd ?? "" : state.cwd
        }
        break
      }
      case "response_item": {
        const typed = record.payload.content
          .filter((item) => item.type === "input_text")
          .map((item) => codexHumanText(item.text ?? ""))
          .filter((text) => text !== "")
          .join("\n")
        if (typed !== "") state = { ...state, activeTicket: singleTicket(typed) }
        break
      }
      case "event_msg": {
        const observedAt = parseInstant(record.timestamp)
        if (observedAt === null) {
          skipped = countSkip(skipped, "missingTimestamp")
          break
        }
        const info = record.payload.info
        if (info !== undefined && info !== null) {
          const total = info.total_token_usage.total_tokens
          if (state.lastTotal === null || total !== state.lastTotal) {
            const last = info.last_token_usage
            const cached = last.cached_input_tokens ?? 0
            const written = last.cache_write_input_tokens ?? 0
            const reasoning = last.reasoning_output_tokens ?? 0
            const tokens = {
              input: Math.max(0, last.input_tokens - cached - written),
              output: Math.max(0, last.output_tokens - reasoning),
              reasoning,
              cacheRead: cached,
              cacheWrite5m: written,
              cacheWrite1h: 0
            }
            if (tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite5m > 0) {
              events.push({
                agent: "codex",
                dedupeKey: `${file.sessionId}@${line.offset}`,
                machine: file.machine,
                sessionId: file.sessionId,
                occurredAt: observedAt,
                model: state.model ?? "unknown",
                fast: false,
                tokens,
                attribution: { cwd: state.cwd, branch: state.branch, activeTicket: state.activeTicket }
              })
            }
          }
          state = { ...state, lastTotal: total }
        }
        const limits = record.payload.rate_limits
        if (limits !== undefined && limits !== null && limits.limit_id === "codex") {
          for (const snapshot of snapshotsOf(file, observedAt, limits)) snapshots.push(snapshot)
          if (limits.credits !== undefined && limits.credits !== null) {
            balances.push({
              kind: "codex-credits",
              machine: file.machine,
              observedAt,
              value: classifyCodexCredits(limits.credits)
            })
          }
        }
        break
      }
    }
  }

  return { events, snapshots, balances, skipped, state }
}
