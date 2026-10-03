/**
 * Synthetic transcript and rollout lines in the shapes Claude Code and Codex write. Nothing here is
 * copied from a real session.
 */
import { Predicate } from "effect"
import type { SourceLine } from "../src/core/Readers.js"

/**
 * Numbers lines with the byte offsets a file holding them, newline-separated, would give. Objects
 * are written as JSON; a string is written as-is, for content that is deliberately not valid JSON.
 */
export const lines = (...values: ReadonlyArray<string | object>): ReadonlyArray<SourceLine> => {
  let offset = 0
  return values.map((value) => {
    const text = Predicate.isString(value) ? value : JSON.stringify(value)
    const line = { offset, text }
    offset += Buffer.byteLength(text) + 1
    return line
  })
}

export const claudeAssistant = (options: {
  readonly id: string
  readonly requestId?: string
  readonly at: string
  readonly model?: string
  readonly cwd?: string
  readonly branch?: string
  readonly input?: number
  readonly output?: number
  readonly cacheRead?: number
  readonly write5m?: number
  readonly write1h?: number
  readonly speed?: string | null
}) => ({
  type: "assistant",
  timestamp: options.at,
  cwd: options.cwd ?? "/home/dev/code/app",
  gitBranch: options.branch ?? "main",
  sessionId: "11111111-1111-1111-1111-111111111111",
  requestId: options.requestId ?? `req_${options.id}`,
  message: {
    id: options.id,
    model: options.model ?? "claude-opus-5",
    content: [{ type: "text", text: "secret assistant answer" }],
    usage: {
      input_tokens: options.input ?? 10,
      output_tokens: options.output ?? 20,
      cache_read_input_tokens: options.cacheRead ?? 0,
      cache_creation_input_tokens: (options.write5m ?? 0) + (options.write1h ?? 0),
      cache_creation: {
        ephemeral_5m_input_tokens: options.write5m ?? 0,
        ephemeral_1h_input_tokens: options.write1h ?? 0
      },
      // JSON.stringify drops the key when it is undefined, as Claude Code omits it.
      speed: options.speed
    }
  }
})

type UserContent =
  | string
  | ReadonlyArray<{ readonly type: string; readonly text?: string; readonly content?: string }>

export const claudeUser = (content: UserContent, isMeta?: boolean, isSidechain?: boolean) => ({
  type: "user",
  timestamp: "2026-09-01T10:00:00.000Z",
  isMeta,
  isSidechain,
  message: { role: "user", content }
})

const usage = (input: number, cached: number, output: number, reasoning: number, total: number) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  cache_write_input_tokens: 0,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
  total_tokens: total
})

export const codexMeta = (
  cwd: string,
  branch: string,
  fork?: { readonly id: string; readonly historyStart: number; readonly ordinal: number }
) => ({
  timestamp: "2026-09-01T10:00:00.000Z",
  type: "session_meta",
  ordinal: fork?.ordinal,
  payload: {
    id: fork?.id ?? "22222222-2222-2222-2222-222222222222",
    subagent_history_start_ordinal: fork?.historyStart,
    cwd,
    git: { branch }
  }
})

/** Gives a rollout line the ordinal Codex numbers it with. */
export const withOrdinal = <A extends object>(ordinal: number, line: A) => ({ ...line, ordinal })

export const codexTurn = (model: string, cwd?: string) => ({
  timestamp: "2026-09-01T10:00:01.000Z",
  type: "turn_context",
  payload: { model, cwd }
})

export const codexUserItem = (...texts: ReadonlyArray<string>) => ({
  timestamp: "2026-09-01T10:00:02.000Z",
  type: "response_item",
  payload: { type: "message", role: "user", content: texts.map((text) => ({ type: "input_text", text })) }
})

export const codexTokenCount = (options: {
  readonly at: string
  readonly last: readonly [input: number, cached: number, output: number, reasoning: number]
  readonly total: number
  readonly limitId?: string
  readonly primary?: { readonly used: number; readonly minutes: number; readonly resets: number } | null
  readonly secondary?: { readonly used: number; readonly minutes: number; readonly resets: number } | null
  readonly credits?: { readonly has_credits: boolean; readonly unlimited: boolean; readonly balance: string | null }
}) => {
  const [input, cached, output, reasoning] = options.last
  const window = (value: { readonly used: number; readonly minutes: number; readonly resets: number } | null) =>
    value === null ? null : { used_percent: value.used, window_minutes: value.minutes, resets_at: value.resets }
  return {
    timestamp: options.at,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: usage(options.total, 0, 0, 0, options.total),
        last_token_usage: usage(input, cached, output, reasoning, input + output),
        model_context_window: 258_400
      },
      rate_limits: {
        limit_id: options.limitId ?? "codex",
        primary: window(options.primary ?? null),
        secondary: window(options.secondary ?? null),
        credits: options.credits ?? null
      }
    }
  }
}
