import { Schema } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { designReadings, UsageDesignFixture } from "../scripts/design-fixture.js"
import { limitsChart } from "../src/usage-limits-chart.js"

const raw = readFileSync(new URL("../../../design-refs/super-app/fixture.json", import.meta.url), "utf8")
const fixture = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ version: Schema.Literal(1), data: UsageDesignFixture }))
)(raw).data
const Tokens = Schema.Struct({
  data: Schema.Struct({
    usageLimits: Schema.Struct({
      tokens: Schema.Struct({
        title: Schema.String,
        titleClaudeOnly: Schema.String,
        days: Schema.Array(Schema.Struct({ day: Schema.String, total: Schema.Number, claude: Schema.Number }))
      })
    })
  })
})
const tokens = Schema.decodeUnknownSync(Schema.fromJsonString(Tokens))(raw).data.usageLimits.tokens

const usageFor = (name: string) => {
  const state = fixture.usageLimits.states[name]
  if (state === undefined) return expect.unreachable(`Missing ${name} fixture`)
  return designReadings(fixture, state).usage
}

/** The reference bar: at least 4px, the tallest 140px. */
const height = (value: number, max: number) => Math.max(4, Math.round((value / max) * 140))

describe("Usage Limits token chart", () => {
  it("draws the reference bars, title and legend for the hub's own tokens", () => {
    const chart = limitsChart(usageFor("populated"), "atlas", [])
    const max = Math.max(...tokens.days.map((day) => day.total))
    expect(chart?.title).toBe(tokens.title)
    expect(chart?.bars).toEqual(
      tokens.days.map((day) => ({ period: day.day, value: `${String(day.total)}M`, height: height(day.total, max) }))
    )
    expect(chart?.legend).toEqual([
      { text: "Claude 142M", total: false, unknown: false },
      { text: "Codex 76M", total: false, unknown: false },
      { text: "218M total", total: true, unknown: false }
    ])
    expect(chart?.label).toBe(
      `atlas tokens last 7 days: ${tokens.days.map((day) => `${day.day} ${String(day.total)}M`).join(", ")}`
    )
  })

  it("leaves an unreadable tool out of every total and names it as excluded", () => {
    const chart = limitsChart(usageFor("sign-in-required"), "atlas", ["codex"])
    const max = Math.max(...tokens.days.map((day) => day.claude))
    expect(chart?.title).toBe(tokens.titleClaudeOnly)
    expect(chart?.bars.map((bar) => [bar.value, bar.height])).toEqual(
      tokens.days.map((day) => [`${String(day.claude)}M`, height(day.claude, max)])
    )
    expect(chart?.legend).toEqual([
      { text: "Claude 142M", total: false, unknown: false },
      { text: "Codex Unknown, excluded", total: false, unknown: true },
      { text: "142M counted", total: true, unknown: false }
    ])
  })

  it("has no chart for a host without a usage read", () => {
    expect(limitsChart(usageFor("populated"), "birch", [])).toBeNull()
  })
})
