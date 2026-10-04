import { describe, expect, it } from "@effect/vitest"
import {
  assignSlots,
  bookingLabel,
  limitLabel,
  type Measure,
  OTHER,
  readingAt,
  seriesIdentity,
  stackUsage,
  stepPath
} from "../src/client/chartModel.js"
import { tileSnapshots } from "../src/client/Tiles.js"
import type { LimitSnapshot } from "../src/core/Model.js"
import type { BookingSummary, UsageReport } from "../src/shared/contracts.js"

const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }

const booking = (id: string, costUsd: number): BookingSummary => ({
  id,
  booking: { _tag: "Ticket", key: id },
  title: null,
  agents: ["claude"],
  requests: 1,
  tokens,
  costUsd,
  unpricedTokens: 0,
  unpricedModels: []
})

const report = (count: number): UsageReport => {
  const bookings = Array.from({ length: count }, (_, index) => booking(`T-${index + 1}`, count - index))
  return {
    periods: [{ key: "2026-09-01", start: 0 }, { key: "2026-09-02", start: 86_400_000 }],
    bookings,
    cells: bookings.map((summary) => ({
      period: 0,
      booking: summary.id,
      tokens: 100,
      costUsd: summary.costUsd,
      unpricedTokens: 0
    })),
    unpriced: { tokens: 0, models: [] },
    ignoredKeys: []
  }
}

describe("stackUsage", () => {
  it("stacks the top eight Bookings by the measure and folds the rest into Other", () => {
    const stacked = stackUsage(report(10), "cost" satisfies Measure, null)
    expect(stacked.series.map((series) => series.id)).toEqual([
      "T-1",
      "T-2",
      "T-3",
      "T-4",
      "T-5",
      "T-6",
      "T-7",
      "T-8",
      OTHER
    ])
    expect(stacked.columns[0]?.segments.at(-1)).toMatchObject({ id: OTHER, value: 2 + 1 })
    expect(stacked.columns[1]?.segments).toEqual([])
    expect(stacked.max).toBe(55)
  })

  it("draws only the selected Booking when one is picked", () => {
    const stacked = stackUsage(report(10), "tokens", "T-9")
    expect(stacked.series.map((series) => series.id)).toEqual(["T-9"])
    expect(stacked.columns[0]?.segments).toEqual([{ id: "T-9", value: 100, from: 0 }])
  })
})

describe("assignSlots", () => {
  it("keeps a surviving Booking's colour when the set changes", () => {
    const first = assignSlots(new Map(), ["A", "B", "C"])
    const second = assignSlots(first, ["C", "D"])
    expect(second.get("C")).toBe(first.get("C"))
    expect(second.get("D")).toBe(0)
  })
})

describe("labels", () => {
  it("marks a repo Booking apart from a ticket", () => {
    expect(bookingLabel({ _tag: "Repo", name: "npm" })).toBe("npm (repo)")
    expect(bookingLabel({ _tag: "Ticket", key: "RPS-1" })).toBe("RPS-1")
  })

  it("names a limit by its window length, or its provider key when the length is unknown", () => {
    expect(limitLabel("claude", "five_hour", 300)).toBe("Claude 5h")
    expect(limitLabel("codex", "secondary", 10_080)).toBe("Codex weekly")
    expect(limitLabel("claude", "iguana_necktie", null)).toBe("Claude iguana_necktie")
    expect(limitLabel("claude", "*", null)).toBe("Claude limits")
    expect(limitLabel("claude", "seven_day", 10_080)).toBe("Claude weekly")
    expect(limitLabel("claude", "seven_day_opus", 10_080)).toBe("Claude seven_day_opus")
    expect(limitLabel("codex", "primary", 10_080)).toBe("Codex weekly")
  })
})

describe("stepPath", () => {
  it("holds each reading until the next one and leaves Unknown readings as gaps", () => {
    const x = (at: number) => at / 10
    const y = (percent: number) => 100 - percent
    expect(stepPath(
      [
        { at: 0, reading: { _tag: "Known", usedPercent: 10, resetsAt: null } },
        { at: 100, reading: { _tag: "Unknown", reason: "Fetch" } },
        { at: 200, reading: { _tag: "Known", usedPercent: 30, resetsAt: null } }
      ],
      300,
      x,
      y
    )).toBe("M0,90H10M20,70H30")
  })
})

describe("tileSnapshots", () => {
  const snapshot = (label: string, observedAt: number, resetsAt: number | null): LimitSnapshot => ({
    agent: "codex",
    machine: "ser8",
    source: "codex-rollout",
    label,
    windowMinutes: 300,
    observedAt,
    reading: { _tag: "Known", usedPercent: 10, resetsAt }
  })

  it("leaves out a window that reset after its last reading", () => {
    expect(tileSnapshots([snapshot("primary", 0, 50), snapshot("secondary", 0, 500)], 100).map((tile) => tile.label))
      .toEqual(["secondary"])
  })

  it("lets a newer failed poll stand in for the windows read before it", () => {
    const failure: LimitSnapshot = {
      ...snapshot("*", 20, null),
      reading: { _tag: "Unknown", reason: "AuthExpired" }
    }
    expect(tileSnapshots([snapshot("primary", 10, 500), failure], 100).map((tile) => tile.label)).toEqual(["*"])
  })
})

describe("readingAt", () => {
  const points: ReadonlyArray<{ readonly at: number; readonly reading: LimitSnapshot["reading"] }> = [
    { at: 100, reading: { _tag: "Known", usedPercent: 65, resetsAt: 150 } }
  ]

  it("reports a reading until its window resets, and nothing after", () => {
    expect(readingAt(points, 140)).toEqual(points[0]?.reading)
    expect(readingAt(points, 170)).toBeUndefined()
  })
})

describe("seriesIdentity", () => {
  it("tells Codex windows apart by length and Claude windows by name", () => {
    expect(seriesIdentity({ agent: "codex", label: "primary", windowMinutes: 300 })).not.toBe(
      seriesIdentity({ agent: "codex", label: "primary", windowMinutes: 10_080 })
    )
    expect(seriesIdentity({ agent: "claude", label: "seven_day", windowMinutes: 10_080 })).not.toBe(
      seriesIdentity({ agent: "claude", label: "seven_day_opus", windowMinutes: 10_080 })
    )
  })
})
