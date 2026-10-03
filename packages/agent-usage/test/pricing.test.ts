import { describe, expect, it } from "@effect/vitest"
import { Option } from "effect"
import type { Tokens } from "../src/core/Model.js"
import { apiEquivalentCost, normalizeClaudeModel } from "../src/core/Pricing.js"

const tokens = (overrides: Partial<Tokens>): Tokens => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  ...overrides
})

const cost = (agent: "claude" | "codex", model: string, counted: Partial<Tokens>, fast = false) =>
  apiEquivalentCost({ agent, model, fast, tokens: tokens(counted) })

describe("Claude pricing", () => {
  it("prices input, output and both cache-write durations off the input rate", () => {
    // opus-5: $5 in / $25 out per MTok; 5m write ×1.25, 1h write ×2, read ×0.1.
    const usd = cost("claude", "claude-opus-5", {
      input: 1_000_000,
      output: 1_000_000,
      cacheWrite5m: 1_000_000,
      cacheWrite1h: 1_000_000,
      cacheRead: 1_000_000
    })
    expect(Option.getOrThrow(usd)).toBeCloseTo(5 + 25 + 6.25 + 10 + 0.5, 6)
  })

  it("uses fast-mode rates when the request ran fast", () => {
    expect(Option.getOrThrow(cost("claude", "claude-opus-5", { output: 1_000_000 }, true))).toBeCloseTo(50, 6)
  })

  it("leaves a fast request unpriced when its model has no fast rate", () => {
    expect(Option.isNone(cost("claude", "claude-opus-4-6", { input: 1_000_000 }, true))).toBe(true)
    expect(Option.getOrThrow(cost("claude", "claude-opus-4-6", { input: 1_000_000 }))).toBeCloseTo(5, 6)
  })

  it("prices dated and 1M-context ids as their base model", () => {
    expect(normalizeClaudeModel("claude-opus-5[1m]")).toBe("claude-opus-5")
    expect(normalizeClaudeModel("claude-opus-5-20260101")).toBe("claude-opus-5")
  })

  it("is unknown, never zero, for a model with no price", () => {
    expect(Option.isNone(cost("claude", "claude-unreleased-9", { input: 10 }))).toBe(true)
  })
})

describe("Codex pricing", () => {
  it("prices reasoning at the output rate and cache reads at their own rate", () => {
    // gpt-6-sol: $2 in, $10 out, $0.2 cache read per MTok.
    const usd = cost("codex", "gpt-6-sol", { input: 100_000, cacheRead: 100_000, output: 50_000, reasoning: 50_000 })
    expect(Option.getOrThrow(usd)).toBeCloseTo(0.2 + 0.02 + 1, 6)
  })

  it("switches to the long-context tier above 272k prompt tokens", () => {
    // Prompt = 200k uncached + 100k cached = 300k > 272k: tier $4 in, $0.4 read.
    const usd = cost("codex", "gpt-6-sol", { input: 200_000, cacheRead: 100_000 })
    expect(Option.getOrThrow(usd)).toBeCloseTo(0.8 + 0.04, 6)
  })

  it("is unknown for a Codex model missing from the table", () => {
    expect(Option.isNone(cost("codex", "gpt-5.6-astra", { input: 10 }))).toBe(true)
  })
})
