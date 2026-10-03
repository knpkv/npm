import { describe, expect, it } from "@effect/vitest"
import type { AttributionInputs, Tokens } from "../src/core/Model.js"
import { buildLimitsReport, buildUsageReport, isTimeZone, periodsOf } from "../src/core/Report.js"
import type { UsageGroup } from "../src/core/Store.js"

const tokens = (input: number, output = 0): Tokens => ({
  input,
  output,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0
})

const group = (overrides: Partial<UsageGroup> & { readonly attribution: AttributionInputs }): UsageGroup => ({
  bucketStart: Date.parse("2026-09-01T10:00:00Z"),
  agent: "claude",
  model: "claude-opus-5",
  fast: false,
  longPrompt: false,
  requests: 1,
  tokens: tokens(1_000_000),
  ...overrides
})

describe("periodsOf", () => {
  it("splits a range into local days, with a 23-hour day where daylight saving starts", () => {
    const periods = periodsOf({
      from: Date.parse("2026-03-28T00:00:00+01:00"),
      to: Date.parse("2026-03-31T00:00:00+02:00"),
      timeZone: "Europe/Berlin",
      bucket: "day"
    })
    expect(periods.map((period) => period.key)).toEqual(["2026-03-28", "2026-03-29", "2026-03-30"])
    expect(periods[1]?.start).toBe(Date.parse("2026-03-29T00:00:00+01:00"))
    expect(periods[2]?.start).toBe(Date.parse("2026-03-30T00:00:00+02:00"))
  })

  it("keeps half-hour zones whole: an Indian day starts at 18:30 UTC", () => {
    const periods = periodsOf({
      from: Date.parse("2026-09-01T00:00:00+05:30"),
      to: Date.parse("2026-09-02T00:00:00+05:30"),
      timeZone: "Asia/Kolkata",
      bucket: "day"
    })
    expect(periods).toEqual([{ key: "2026-09-01", start: Date.parse("2026-08-31T18:30:00Z") }])
  })

  it("starts weeks on Monday", () => {
    const periods = periodsOf({
      from: Date.parse("2026-09-07T00:00:00Z"),
      to: Date.parse("2026-09-21T00:00:00Z"),
      timeZone: "UTC",
      bucket: "week"
    })
    expect(periods.map((period) => period.key)).toEqual(["2026-09-07", "2026-09-14"])
  })

  it("accepts IANA zones and UTC, and nothing else", () => {
    expect(isTimeZone("Europe/Berlin")).toBe(true)
    expect(isTimeZone("UTC")).toBe(true)
    expect(isTimeZone("Mars/Olympus")).toBe(false)
  })
})

describe("buildUsageReport", () => {
  const periods = [
    { key: "2026-09-01", start: Date.parse("2026-09-01T00:00:00Z") },
    { key: "2026-09-02", start: Date.parse("2026-09-02T00:00:00Z") }
  ]

  it("books groups to tickets and repos, prices them, and keeps unpriced tokens visible", () => {
    const report = buildUsageReport(
      [
        group({ attribution: { cwd: "/w/app", branch: "feat/RPS-1", activeTicket: null } }),
        group({
          bucketStart: Date.parse("2026-09-02T09:00:00Z"),
          attribution: { cwd: "/w/app", branch: "feat/RPS-1", activeTicket: null }
        }),
        group({ model: "claude-unreleased-9", attribution: { cwd: "/w/app", branch: "main", activeTicket: null } })
      ],
      periods,
      { "RPS-1": { _tag: "Known", summary: "Fix login" } }
    )
    expect(report.bookings.map((booking) => [booking.id, booking.costUsd, booking.unpricedTokens])).toEqual([
      ["ticket:RPS-1", 10, 0],
      ["repo:app", 0, 1_000_000]
    ])
    expect(report.bookings[0]?.title).toEqual({ _tag: "Known", summary: "Fix login" })
    expect(report.bookings[1]?.title).toBeNull()
    expect(report.cells).toEqual([
      { period: 0, booking: "ticket:RPS-1", tokens: 1_000_000, costUsd: 5, unpricedTokens: 0 },
      { period: 0, booking: "repo:app", tokens: 1_000_000, costUsd: 0, unpricedTokens: 1_000_000 },
      { period: 1, booking: "ticket:RPS-1", tokens: 1_000_000, costUsd: 5, unpricedTokens: 0 }
    ])
    expect(report.unpriced).toEqual({ tokens: 1_000_000, models: ["claude-unreleased-9"] })
  })

  it("drops groups outside every period", () => {
    const report = buildUsageReport(
      [group({
        bucketStart: Date.parse("2026-08-31T23:45:00Z"),
        attribution: { cwd: "/w/a", branch: "", activeTicket: null }
      })],
      periods,
      {}
    )
    expect(report.cells).toEqual([])
  })
})

describe("buildLimitsReport", () => {
  it("starts each series at the range's left edge with the reading in force there", () => {
    const report = buildLimitsReport(
      [
        {
          agent: "codex",
          machine: "ser8",
          source: "codex-rollout",
          label: "secondary",
          windowMinutes: 10080,
          observedAt: 500,
          reading: { _tag: "Known", usedPercent: 10, resetsAt: null }
        },
        {
          agent: "codex",
          machine: "ser8",
          source: "codex-rollout",
          label: "secondary",
          windowMinutes: 10080,
          observedAt: 1_500,
          reading: { _tag: "Known", usedPercent: 20, resetsAt: null }
        }
      ],
      { from: 1_000, to: 2_000 }
    )
    expect(report.series).toEqual([{
      agent: "codex",
      label: "secondary",
      windowMinutes: 10080,
      points: [
        { at: 1_000, reading: { _tag: "Known", usedPercent: 10, resetsAt: null } },
        { at: 1_500, reading: { _tag: "Known", usedPercent: 20, resetsAt: null } }
      ]
    }])
    expect(report.latest.map((snapshot) => snapshot.observedAt)).toEqual([1_500])
  })
})
