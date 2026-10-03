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
 * - **A fork repeats its parent.** A forked subagent rollout starts with a copy of the parent's
 *   history, below `subagent_history_start_ordinal`; that copy only advances the running total.
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

/** A Codex usage block with optional fields filled in, as codex-session-cost.jq normalizes it. */
export const CodexUsage = Schema.Struct({
  input: Count,
  cached: Count,
  cacheWrite: Count,
  output: Count,
  reasoning: Count,
  total: Count
})
export type CodexUsage = typeof CodexUsage.Type

const zeroUsage: CodexUsage = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 }

/**
 * The tokens one token_count adds, ported exactly from codex-session-cost.jq's `usage_delta`:
 * an unchanged running total adds nothing (a rate-limit-only re-emit); a first event, a reset
 * total, or a last usage equal to the whole total adds the last usage; otherwise the difference of
 * running totals, which also recovers tokens of any token_count in between that failed to decode.
 */
export const usageDelta = (previous: CodexUsage | null, total: CodexUsage, last: CodexUsage): CodexUsage => {
  if (previous !== null && total.total === previous.total) return zeroUsage
  if (previous === null || total.total < previous.total || total.total === last.total) return last
  return {
    input: total.input - previous.input,
    cached: total.cached - previous.cached,
    cacheWrite: total.cacheWrite - previous.cacheWrite,
    output: total.output - previous.output,
    reasoning: total.reasoning - previous.reasoning,
    total: total.total - previous.total
  }
}

export const CodexReaderState = Schema.Struct({
  cwd: Schema.String,
  branch: Schema.String,
  model: Schema.NullOr(Schema.String),
  activeTicket: Schema.NullOr(Schema.String),
  /** The session's running usage at the last valid token_count read. */
  previousTotal: Schema.NullOr(CodexUsage),
  /** This rollout's own session id, from its first session_meta. */
  ownSession: Schema.NullOr(Schema.String),
  /**
   * A forked subagent rollout copies its parent's history first; lines with an ordinal below this
   * one are that copy, already booked from the parent's own rollout.
   */
  historyStart: Schema.NullOr(Schema.Int)
})
export type CodexReaderState = typeof CodexReaderState.Type

export const initialCodexState: CodexReaderState = {
  cwd: "",
  branch: "",
  model: null,
  activeTicket: null,
  previousTotal: null,
  ownSession: null,
  historyStart: null
}

const TokenUsage = Schema.Struct({
  input_tokens: Count,
  cached_input_tokens: Schema.optionalKey(Count),
  cache_write_input_tokens: Schema.optionalKey(Count),
  output_tokens: Count,
  reasoning_output_tokens: Schema.optionalKey(Count),
  total_tokens: Count
})

const normalizeUsage = (usage: typeof TokenUsage.Type): CodexUsage => ({
  input: usage.input_tokens,
  cached: usage.cached_input_tokens ?? 0,
  cacheWrite: usage.cache_write_input_tokens ?? 0,
  output: usage.output_tokens,
  reasoning: usage.reasoning_output_tokens ?? 0,
  total: usage.total_tokens
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
    ordinal: Schema.optionalKey(Schema.Int),
    payload: Schema.Struct({
      id: Schema.optionalKey(Schema.String),
      subagent_history_start_ordinal: Schema.optionalKey(Schema.NullOr(Schema.Int)),
      cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
      git: Schema.optionalKey(
        Schema.NullOr(Schema.Struct({ branch: Schema.optionalKey(Schema.NullOr(Schema.String)) }))
      )
    })
  }),
  Schema.Struct({
    type: Schema.Literal("turn_context"),
    ordinal: Schema.optionalKey(Schema.Int),
    payload: Schema.Struct({
      model: Schema.optionalKey(Schema.NullOr(Schema.String)),
      cwd: Schema.optionalKey(Schema.NullOr(Schema.String))
    })
  }),
  Schema.Struct({
    type: Schema.Literal("response_item"),
    ordinal: Schema.optionalKey(Schema.Int),
    payload: Schema.Struct({
      type: Schema.Literal("message"),
      role: Schema.Literal("user"),
      content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }))
    })
  }),
  Schema.Struct({
    type: Schema.Literal("event_msg"),
    ordinal: Schema.optionalKey(Schema.Int),
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

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(RolloutLine))

/** Lines a decode is spent on; everything else in a rollout is conversation or tool traffic. */
const RELEVANT = ["\"session_meta\"", "\"turn_context\"", "\"token_count\"", "\"role\":\"user\""]
const mayMatter = (text: string): boolean => RELEVANT.some((marker) => text.includes(marker))

/** User-role response items that fail to decode are other item kinds; only these count as damage. */
const mustDecode = (text: string): boolean =>
  text.includes("\"session_meta\"") || text.includes("\"turn_context\"") || text.includes("\"token_count\"")

type RolloutWindow = typeof Window.Type

const snapshotOf = (
  file: SourceFile,
  observedAt: number,
  label: "primary" | "secondary",
  window: RolloutWindow | null | undefined
): ReadonlyArray<LimitSnapshot> => {
  if (window === undefined || window === null) return []
  const minutes = window.window_minutes
  const resets = window.resets_at
  const snapshot: LimitSnapshot = {
    agent: "codex",
    machine: file.machine,
    source: "codex-rollout",
    label,
    windowMinutes: minutes !== undefined && minutes !== null && minutes > 0 ? minutes : null,
    observedAt,
    reading: {
      _tag: "Known",
      usedPercent: window.used_percent,
      resetsAt: resets === undefined || resets === null ? null : Math.round(resets * 1000)
    }
  }
  return [snapshot]
}

const snapshotsOf = (
  file: SourceFile,
  observedAt: number,
  limits: typeof RateLimits.Type
): ReadonlyArray<LimitSnapshot> => [
  ...snapshotOf(file, observedAt, "primary", limits.primary),
  ...snapshotOf(file, observedAt, "secondary", limits.secondary)
]

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
    const copied = state.historyStart !== null && record.ordinal !== undefined && record.ordinal < state.historyStart
    switch (record.type) {
      case "session_meta": {
        // A fork copies its parent's session_meta too; only this rollout's own one describes it.
        // The rollout's file name carries its own id, so the order of the two lines does not matter;
        // without an id in the name, the first session_meta is taken as the rollout's own.
        const id = record.payload.id ?? null
        const own = state.ownSession ?? (SESSION_ID.test(file.sessionId) ? file.sessionId : id)
        if (own !== null && id !== null && id !== own) break
        state = {
          ...state,
          ownSession: own,
          historyStart: state.historyStart ?? record.payload.subagent_history_start_ordinal ?? null,
          cwd: record.payload.cwd ?? state.cwd,
          branch: record.payload.git?.branch ?? state.branch
        }
        break
      }
      case "turn_context": {
        // Each turn says where it ran; a resumed session may have moved to another worktree. The
        // branch was read for the old directory, so a move drops it rather than book the new work to
        // the old branch's ticket.
        const cwd = record.payload.cwd ?? state.cwd
        state = {
          ...state,
          model: record.payload.model ?? state.model,
          cwd,
          branch: cwd === state.cwd || state.cwd === "" ? state.branch : ""
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
          const total = normalizeUsage(info.total_token_usage)
          const delta = usageDelta(state.previousTotal, total, normalizeUsage(info.last_token_usage))
          // Codex counts cache hits inside input and reasoning inside output; split them out.
          const tokens = {
            input: Math.max(0, delta.input - delta.cached - delta.cacheWrite),
            output: Math.max(0, delta.output - delta.reasoning),
            reasoning: Math.max(0, delta.reasoning),
            cacheRead: Math.max(0, delta.cached),
            cacheWrite5m: Math.max(0, delta.cacheWrite),
            cacheWrite1h: 0
          }
          // Copied fork history only advances the running total, so the fork's own first request
          // diffs against the right baseline; its requests were booked from the parent's rollout.
          if (delta.total !== 0 && !copied) {
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
          state = { ...state, previousTotal: total }
        }
        const limits = record.payload.rate_limits
        // Copied history carries the parent's limit readings restamped at fork time: not observations.
        if (!copied && limits !== undefined && limits !== null && limits.limit_id === "codex") {
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
