/**
 * API-Equivalent Cost: what a Usage Event's tokens would cost at today's list price.
 *
 * **Mental model**
 *
 * - **Priced when read** (ADR 0002). Nothing here is persisted, so updating a rate or adding a model
 *   reprices every event already stored, past ones included. The UI says so.
 * - **Unknown is not free.** A model missing from the table, or a cache rate the table lacks for
 *   tokens that were actually cached, yields `Option.none()`.
 * - **No network.** The tables are a snapshot: Claude's from Anthropic's list prices, Codex's from
 *   the models.dev catalog. Updating them is a release.
 *
 * @module
 */
import { Option } from "effect"
import type { Agent, Tokens } from "./Model.js"

const PER_MTOK = 1_000_000

interface ClaudeRates {
  readonly input: number
  readonly output: number
}

// Cache writes cost more than fresh input; reads cost a tenth of it.
const CLAUDE_CACHE_WRITE_5M = 1.25
const CLAUDE_CACHE_WRITE_1H = 2
const CLAUDE_CACHE_READ = 0.1

/** USD per million tokens, keyed by normalized model id. */
const CLAUDE_STANDARD: ReadonlyMap<string, ClaudeRates> = new Map([
  ["claude-fable-5-1", { input: 10, output: 50 }],
  ["claude-fable-5", { input: 10, output: 50 }],
  ["claude-mythos-5-1", { input: 10, output: 50 }],
  ["claude-mythos-5", { input: 10, output: 50 }],
  ["claude-opus-5-5", { input: 4, output: 20 }],
  ["claude-opus-5", { input: 5, output: 25 }],
  ["claude-opus-4-8", { input: 5, output: 25 }],
  ["claude-opus-4-7", { input: 5, output: 25 }],
  ["claude-opus-4-6", { input: 5, output: 25 }],
  ["claude-opus-4-5", { input: 5, output: 25 }],
  ["claude-sonnet-5", { input: 2, output: 10 }],
  ["claude-sonnet-4-6", { input: 3, output: 15 }],
  ["claude-sonnet-4-5", { input: 3, output: 15 }],
  ["claude-haiku-4-5", { input: 1, output: 5 }]
])

/** Fast mode: the same model at premium rates. */
const CLAUDE_FAST: ReadonlyMap<string, ClaudeRates> = new Map([
  ["claude-opus-5-5", { input: 8, output: 40 }],
  ["claude-opus-5", { input: 10, output: 50 }],
  ["claude-opus-4-8", { input: 10, output: 50 }]
])

interface CodexRates {
  readonly input: number
  readonly output: number
  readonly cacheRead: number | null
  readonly cacheWrite: number | null
}

interface CodexPrice extends CodexRates {
  /** Rates that apply to a Long Prompt. */
  readonly longContext: CodexRates | null
}

/** A Codex request whose prompt exceeds this many tokens is billed at its model's long-context tier. */
export const LONG_PROMPT_TOKENS = 272_000

/** Every token of a request's prompt: uncached input, cache reads and cache writes. */
export const promptTokens = (tokens: Tokens): number =>
  tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h

/** True when one request's prompt falls in the long-context tier. */
export const isLongPrompt = (tokens: Tokens): boolean => promptTokens(tokens) > LONG_PROMPT_TOKENS

const flat = (input: number, output: number, cacheRead: number | null): CodexPrice => ({
  input,
  output,
  cacheRead,
  cacheWrite: null,
  longContext: null
})

const tiered = (base: CodexRates, long: CodexRates): CodexPrice => ({
  ...base,
  longContext: long
})

const rates = (input: number, output: number, cacheRead: number | null, cacheWrite: number | null): CodexRates => ({
  input,
  output,
  cacheRead,
  cacheWrite
})

/** USD per million tokens from the models.dev catalog, for the models Codex runs. */
const CODEX: ReadonlyMap<string, CodexPrice> = new Map([
  ["gpt-5", flat(1.25, 10, 0.125)],
  ["gpt-5-mini", flat(0.25, 2, 0.025)],
  ["gpt-5-nano", flat(0.05, 0.4, 0.005)],
  ["gpt-5.1", flat(1.25, 10, 0.125)],
  ["gpt-5.2", flat(1.75, 14, 0.175)],
  ["gpt-5.3-codex", flat(1.75, 14, 0.175)],
  ["gpt-5.3-codex-spark", flat(1.75, 14, 0.175)],
  ["gpt-5.4", tiered(rates(2.5, 15, 0.25, null), rates(5, 22.5, 0.5, null))],
  ["gpt-5.4-mini", flat(0.75, 4.5, 0.075)],
  ["gpt-5.4-nano", flat(0.2, 1.25, 0.02)],
  ["gpt-5.5", tiered(rates(5, 30, 0.5, null), rates(10, 45, 1, null))],
  ["gpt-5.6", tiered(rates(4, 20, 0.4, 5), rates(8, 30, 0.8, 10))],
  ["gpt-5.6-luna", tiered(rates(0.2, 1.2, 0.02, 0.25), rates(0.4, 1.8, 0.04, 0.5))],
  ["gpt-5.6-sol", tiered(rates(4, 20, 0.4, 5), rates(8, 30, 0.8, 10))],
  ["gpt-5.6-terra", tiered(rates(2, 12, 0.2, 2.5), rates(4, 18, 0.4, 5))],
  ["gpt-6-astra", tiered(rates(10, 50, 1, 12.5), rates(20, 75, 2, 25))],
  ["gpt-6-luna", tiered(rates(0.1, 0.5, 0.01, 0.125), rates(0.2, 0.75, 0.02, 0.25))],
  ["gpt-6-sol", tiered(rates(2, 10, 0.2, 2.5), rates(4, 15, 0.4, 5))],
  ["gpt-6.1-sol", tiered(rates(2, 10, 0.1, 2.5), rates(4, 15, 0.2, 5))]
])

/** `claude-opus-5[1m]` and `claude-opus-5-20260101` both price as `claude-opus-5`. */
export const normalizeClaudeModel = (model: string): string => model.replace(/\[[^\]]*\]$/u, "").replace(/-\d{8}$/u, "")

const claudeCost = (model: string, fast: boolean, tokens: Tokens): Option.Option<number> => {
  const id = normalizeClaudeModel(model)
  // A fast request without a fast rate is unpriced, not priced at the standard rate.
  const found = fast ? CLAUDE_FAST.get(id) : CLAUDE_STANDARD.get(id)
  if (found === undefined) return Option.none()
  const input = tokens.input +
    tokens.cacheWrite5m * CLAUDE_CACHE_WRITE_5M +
    tokens.cacheWrite1h * CLAUDE_CACHE_WRITE_1H +
    tokens.cacheRead * CLAUDE_CACHE_READ
  return Option.some((input * found.input + (tokens.output + tokens.reasoning) * found.output) / PER_MTOK)
}

const codexCost = (model: string, longPrompt: boolean, tokens: Tokens): Option.Option<number> => {
  const price = CODEX.get(model)
  if (price === undefined) return Option.none()
  const cacheWrite = tokens.cacheWrite5m + tokens.cacheWrite1h
  const applied: CodexRates = longPrompt && price.longContext !== null ? price.longContext : price
  const cacheReadUsd = tokens.cacheRead === 0
    ? 0
    : applied.cacheRead === null
    ? null
    : tokens.cacheRead * applied.cacheRead
  const cacheWriteUsd = cacheWrite === 0 ? 0 : applied.cacheWrite === null ? null : cacheWrite * applied.cacheWrite
  if (cacheReadUsd === null || cacheWriteUsd === null) return Option.none()
  return Option.some(
    (tokens.input * applied.input + cacheReadUsd + cacheWriteUsd +
      (tokens.output + tokens.reasoning) * applied.output) / PER_MTOK
  )
}

/** Requests that price alike: one agent, model and speed, all Long Prompts or none. */
export interface PricedGroup {
  readonly agent: Agent
  readonly model: string
  readonly fast: boolean
  readonly longPrompt: boolean
  /** The group's summed tokens. Pricing is linear within a group, so a sum prices like its parts. */
  readonly tokens: Tokens
}

/** A group's cost at current list price, or none when its model or a needed rate is unpriced. */
export const groupCost = (group: PricedGroup): Option.Option<number> =>
  group.agent === "claude"
    ? claudeCost(group.model, group.fast, group.tokens)
    : codexCost(group.model, group.longPrompt, group.tokens)

/** One request's cost at current list price, or none when its model or a needed rate is unpriced. */
export const apiEquivalentCost = (request: {
  readonly agent: Agent
  readonly model: string
  readonly fast: boolean
  readonly tokens: Tokens
}): Option.Option<number> => groupCost({ ...request, longPrompt: isLongPrompt(request.tokens) })
