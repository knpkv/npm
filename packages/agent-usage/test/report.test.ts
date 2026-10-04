import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { AttributionInputs, LimitSnapshot, Tokens } from "../src/core/Model.js"
import { buildLimitsReport, buildUsageReport, checkTimeZone, periodsOf } from "../src/core/Report.js"
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

  it("keeps both 02:00 hours apart on the night clocks go back", () => {
    const periods = periodsOf({
      from: Date.parse("2026-10-25T00:00:00+02:00"),
      to: Date.parse("2026-10-26T00:00:00+01:00"),
      timeZone: "Europe/Amsterdam",
      bucket: "hour"
    })
    expect(periods).toHaveLength(25)
    expect(periods.every((period, index) => index === 0 || period.start > (periods[index - 1]?.start ?? 0))).toBe(true)
  })

  it("has 23 hours on the night clocks go forward", () => {
    const periods = periodsOf({
      from: Date.parse("2026-03-29T00:00:00+01:00"),
      to: Date.parse("2026-03-30T00:00:00+02:00"),
      timeZone: "Europe/Amsterdam",
      bucket: "hour"
    })
    expect(periods).toHaveLength(23)
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

  it.effect("accepts every zone the formatter takes, aliases and fixed offsets included", () =>
    Effect.gen(function*() {
      for (const zone of ["Europe/Berlin", "UTC", "Etc/GMT+5", "Europe/Kyiv", "Asia/Calcutta"]) {
        expect(yield* checkTimeZone(zone)).toBe(zone)
      }
      expect((yield* Effect.flip(checkTimeZone("Mars/Olympus")))._tag).toBe("UnknownTimeZone")
    }))
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
      { "RPS-1": { _tag: "Known", summary: "Fix login" } },
      new Set(["RPS"])
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

  it("books typed keys of unknown projects to the repo and counts them by prefix", () => {
    const report = buildUsageReport(
      [
        group({ requests: 3, attribution: { cwd: "/w/app", branch: "main", activeTicket: "GPT-6" } }),
        group({ requests: 2, attribution: { cwd: "/w/app", branch: "main", activeTicket: "RPS-7071" } })
      ],
      periods,
      {},
      new Set(["RPS"])
    )
    expect(report.bookings.map((booking) => booking.id).sort()).toEqual(["repo:app", "ticket:RPS-7071"])
    expect(report.ignoredKeys).toEqual([{ prefix: "GPT", requests: 3 }])
  })

  it("counts a request in the first, partial 15-minute bucket of a range that starts mid-bucket", () => {
    const from = Date.parse("2026-09-01T10:07:00Z")
    const report = buildUsageReport(
      [group({
        bucketStart: Date.parse("2026-09-01T10:00:00Z"),
        attribution: { cwd: "/w/a", branch: "", activeTicket: null }
      })],
      periodsOf({ from, to: from + 3_600_000, timeZone: "UTC", bucket: "hour" }),
      {},
      new Set()
    )
    expect(report.cells.map((cell) => cell.period)).toEqual([0])
  })

  it("drops groups outside every period", () => {
    const report = buildUsageReport(
      [group({
        bucketStart: Date.parse("2026-08-31T23:45:00Z"),
        attribution: { cwd: "/w/a", branch: "", activeTicket: null }
      })],
      periods,
      {},
      new Set()
    )
    expect(report.cells).toEqual([])
  })
})

describe("buildLimitsReport", () => {
  it("draws a Claude window as one series whether a poll or a statusline sample observed it", () => {
    const claude = (
      source: "claude-oauth-usage" | "claude-statusline",
      observedAt: number,
      usedPercent: number
    ): LimitSnapshot => ({
      agent: "claude",
      machine: "host-a",
      source,
      label: "five_hour",
      windowMinutes: 300,
      observedAt,
      reading: { _tag: "Known", usedPercent, resetsAt: null }
    })
    const report = buildLimitsReport(
      [
        claude("claude-oauth-usage", 1_100, 5),
        claude("claude-statusline", 1_200, 7),
        claude("claude-oauth-usage", 1_300, 9)
      ],
      { from: 1_000, to: 2_000 }
    )
    expect(report.series).toHaveLength(1)
    expect(report.series[0]?.points.map((point) => point.at)).toEqual([1_100, 1_200, 1_300])
    expect(report.latest.map((snapshot) => snapshot.source)).toEqual(["claude-oauth-usage"])
  })

  it("starts each series at the range's left edge with the reading in force there", () => {
    const report = buildLimitsReport(
      [
        {
          agent: "codex",
          machine: "host-a",
          source: "codex-rollout",
          label: "secondary",
          windowMinutes: 10080,
          observedAt: 500,
          reading: { _tag: "Known", usedPercent: 10, resetsAt: null }
        },
        {
          agent: "codex",
          machine: "host-a",
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

  it("joins Codex windows of one length whatever slot the plan put them in, and keeps Claude keys apart", () => {
    const snapshot = (
      agent: "claude" | "codex",
      source: "claude-oauth-usage" | "codex-rollout",
      label: string,
      observedAt: number
    ): LimitSnapshot => ({
      agent,
      machine: "host-a",
      source,
      label,
      windowMinutes: 10_080,
      observedAt,
      reading: { _tag: "Known", usedPercent: observedAt / 100, resetsAt: null }
    })
    const report = buildLimitsReport([
      snapshot("codex", "codex-rollout", "secondary", 1_100),
      snapshot("codex", "codex-rollout", "primary", 1_200),
      snapshot("claude", "claude-oauth-usage", "seven_day", 1_300),
      snapshot("claude", "claude-oauth-usage", "seven_day_opus", 1_400)
    ], { from: 1_000, to: 2_000 })
    expect(report.series.map((series) => [series.agent, series.label, series.points.length])).toEqual([
      ["claude", "seven_day", 1],
      ["claude", "seven_day_opus", 1],
      ["codex", "primary", 2]
    ])
    expect(report.latest.map((latest) => latest.label)).toEqual(["seven_day", "seven_day_opus", "primary"])
  })

  it("drops a series whose last reading before the range had already reset", () => {
    const report = buildLimitsReport([{
      agent: "codex",
      machine: "host-a",
      source: "codex-rollout",
      label: "primary",
      windowMinutes: 300,
      observedAt: 100,
      reading: { _tag: "Known", usedPercent: 65, resetsAt: 500 }
    }], { from: 1_000, to: 2_000 })
    expect(report.series).toEqual([])
    expect(report.latest).toHaveLength(1)
  })

  const claude = (label: string, observedAt: number, reading: LimitSnapshot["reading"]): LimitSnapshot => ({
    agent: "claude",
    machine: "host-a",
    source: "claude-oauth-usage",
    label,
    windowMinutes: label === "five_hour" ? 300 : null,
    observedAt,
    reading
  })

  it("breaks every Claude window across a poll that could not read any of them", () => {
    const report = buildLimitsReport([
      claude("five_hour", 1_100, { _tag: "Known", usedPercent: 40, resetsAt: null }),
      claude("*", 1_200, { _tag: "Unknown", reason: "AuthExpired" }),
      claude("five_hour", 1_300, { _tag: "Known", usedPercent: 55, resetsAt: null })
    ], { from: 1_000, to: 2_000 })
    expect(report.series.find((series) => series.label === "five_hour")?.points.map((point) => point.reading._tag))
      .toEqual(["Known", "Unknown", "Known"])
  })

  it("adds no gap when the failed poll came before every window reading", () => {
    const report = buildLimitsReport([
      claude("*", 1_050, { _tag: "Unknown", reason: "Fetch" }),
      claude("five_hour", 1_100, { _tag: "Known", usedPercent: 40, resetsAt: null })
    ], { from: 1_000, to: 2_000 })
    expect(report.series.find((series) => series.label === "five_hour")?.points.map((point) => point.reading._tag))
      .toEqual(["Known"])
  })
})
